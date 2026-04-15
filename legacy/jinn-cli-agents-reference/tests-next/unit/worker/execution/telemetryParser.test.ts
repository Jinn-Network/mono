/**
 * Unit Test: Telemetry Parser
 * Module: worker/execution/telemetryParser.ts
 * Priority: P1 (HIGH)
 *
 * Tests telemetry extraction and parsing from agent execution results.
 * Critical for recognition system, tool call tracking, and error detection.
 *
 * Impact: Prevents recognition failures, improves agent memory
 */

import { describe, expect, it } from 'vitest';
import {
  parseTelemetry,
  extractOutput,
  mergeTelemetry,
} from 'jinn-node/worker/execution/telemetryParser.js';
import type { AgentExecutionResult } from 'jinn-node/worker/types.js';

describe('telemetryParser', () => {
  describe('parseTelemetry', () => {
    describe('successful execution', () => {
      it('returns telemetry from result', () => {
        const result: AgentExecutionResult = {
          output: 'Task completed',
          telemetry: {
            duration: 5000,
            toolCalls: [{ tool: 'read_file', success: true }],
          },
        };

        const parsed = parseTelemetry(result);

        expect(parsed.telemetry).toEqual(result.telemetry);
        expect(parsed.hasPartialOutput).toBe(false);
        expect(parsed.processExitError).toBe(false);
      });

      it('handles empty telemetry', () => {
        const result: AgentExecutionResult = {
          output: 'Done',
          telemetry: {},
        };

        const parsed = parseTelemetry(result);

        expect(parsed.telemetry).toEqual({});
        expect(parsed.hasPartialOutput).toBe(false);
        expect(parsed.processExitError).toBe(false);
      });

      it('handles missing telemetry', () => {
        const result: AgentExecutionResult = {
          output: 'Done',
        };

        const parsed = parseTelemetry(result);

        expect(parsed.telemetry).toEqual({});
      });
    });

    describe('process exit errors', () => {
      it('detects process exit in error message', () => {
        const result: AgentExecutionResult = {
          output: '',
          telemetry: {},
        };
        const error = {
          message: 'Agent process exited with code 1',
        };

        const parsed = parseTelemetry(result, error);

        expect(parsed.processExitError).toBe(true);
      });

      it('detects process exit in stderr', () => {
        const result: AgentExecutionResult = {
          output: '',
          telemetry: {},
        };
        const error = {
          error: {
            stderr: 'Process exited with code 137',
          },
        };

        const parsed = parseTelemetry(result, error);

        expect(parsed.processExitError).toBe(true);
      });

      it('detects PROCESS_ERROR type in error telemetry', () => {
        const result: AgentExecutionResult = {
          output: '',
          telemetry: {},
        };
        const error = {
          telemetry: {
            errorType: 'PROCESS_ERROR',
          },
        };

        const parsed = parseTelemetry(result, error);

        expect(parsed.processExitError).toBe(true);
      });

      it('handles case-insensitive process exit detection', () => {
        const result: AgentExecutionResult = {
          output: '',
          telemetry: {},
        };
        const error = {
          message: 'PROCESS EXITED WITH CODE 2',
        };

        const parsed = parseTelemetry(result, error);

        expect(parsed.processExitError).toBe(true);
      });

      it('does not flag false positives', () => {
        const result: AgentExecutionResult = {
          output: '',
          telemetry: {},
        };
        const error = {
          message: 'Network timeout',
        };

        const parsed = parseTelemetry(result, error);

        expect(parsed.processExitError).toBe(false);
      });
    });

    describe('partial output detection', () => {
      it('detects partial output from stderr', () => {
        const result: AgentExecutionResult = {
          output: '',
          telemetry: {},
        };
        const error = {
          error: {
            stderr: 'Partial execution output',
          },
        };

        const parsed = parseTelemetry(result, error);

        expect(parsed.hasPartialOutput).toBe(true);
      });

      it('detects partial output from error telemetry', () => {
        const result: AgentExecutionResult = {
          output: '',
          telemetry: {},
        };
        const error = {
          telemetry: {
            raw: {
              partialOutput: 'Incomplete results...',
            },
          },
        };

        const parsed = parseTelemetry(result, error);

        expect(parsed.hasPartialOutput).toBe(true);
      });

      it('detects partial output when result has output but error exists', () => {
        const result: AgentExecutionResult = {
          output: 'Partial output before crash',
          telemetry: {},
        };
        const error = {
          message: 'Process crashed',
        };

        const parsed = parseTelemetry(result, error);

        expect(parsed.hasPartialOutput).toBe(true);
      });

      it('does not flag partial output when no error', () => {
        const result: AgentExecutionResult = {
          output: 'Complete output',
          telemetry: {},
        };

        const parsed = parseTelemetry(result);

        expect(parsed.hasPartialOutput).toBe(false);
      });
    });

    describe('error telemetry precedence', () => {
      it('prefers error telemetry when present', () => {
        const result: AgentExecutionResult = {
          output: 'Done',
          telemetry: {
            duration: 5000,
          },
        };
        const error = {
          telemetry: {
            duration: 3000,
            errorType: 'TIMEOUT',
            partialToolCalls: [],
          },
        };

        const parsed = parseTelemetry(result, error);

        expect(parsed.telemetry).toEqual(error.telemetry);
      });

      it('uses result telemetry when error telemetry is empty', () => {
        const result: AgentExecutionResult = {
          output: 'Done',
          telemetry: {
            duration: 5000,
          },
        };
        const error = {
          telemetry: {},
        };

        const parsed = parseTelemetry(result, error);

        expect(parsed.telemetry).toEqual(result.telemetry);
      });

      it('uses result telemetry when error telemetry is not an object', () => {
        const result: AgentExecutionResult = {
          output: 'Done',
          telemetry: {
            duration: 5000,
          },
        };
        const error = {
          telemetry: 'string telemetry',
        };

        const parsed = parseTelemetry(result, error);

        expect(parsed.telemetry).toEqual(result.telemetry);
      });
    });

    describe('edge cases', () => {
      it('handles null result', () => {
        const parsed = parseTelemetry(null as any);

        expect(parsed.telemetry).toEqual({});
        expect(parsed.hasPartialOutput).toBe(false);
        expect(parsed.processExitError).toBe(false);
      });

      it('handles undefined error', () => {
        const result: AgentExecutionResult = {
          output: 'Done',
          telemetry: {},
        };

        const parsed = parseTelemetry(result, undefined);

        expect(parsed.processExitError).toBe(false);
        expect(parsed.hasPartialOutput).toBe(false);
      });

      it('handles error without message field', () => {
        const result: AgentExecutionResult = {
          output: '',
          telemetry: {},
        };
        const error = { code: 500 };

        const parsed = parseTelemetry(result, error);

        expect(parsed.processExitError).toBe(false);
      });

      it('handles complex nested error structure', () => {
        const result: AgentExecutionResult = {
          output: '',
          telemetry: {},
        };
        const error = {
          message: 'Top level error',
          error: {
            stderr: 'Process exited with code 1',
            stdout: 'Some output',
          },
          telemetry: {
            errorType: 'PROCESS_ERROR',
            raw: {
              partialOutput: 'Partial...',
            },
          },
        };

        const parsed = parseTelemetry(result, error);

        expect(parsed.processExitError).toBe(true);
        expect(parsed.hasPartialOutput).toBe(true);
        expect(parsed.telemetry).toEqual(error.telemetry);
      });
    });
  });

  describe('extractOutput', () => {
    describe('from result', () => {
      it('extracts string output', () => {
        const result: AgentExecutionResult = {
          output: 'Task completed successfully',
          telemetry: {},
        };

        const output = extractOutput(result);

        expect(output).toBe('Task completed successfully');
      });

      it('stringifies non-string output', () => {
        const result: AgentExecutionResult = {
          output: { status: 'success', data: [1, 2, 3] } as any,
          telemetry: {},
        };

        const output = extractOutput(result);

        expect(output).toBe('{"status":"success","data":[1,2,3]}');
      });

      it('handles empty string output', () => {
        const result: AgentExecutionResult = {
          output: '',
          telemetry: {},
        };

        const output = extractOutput(result);

        expect(output).toBe('');
      });
    });

    describe('from error partial output', () => {
      it('extracts partial output from error telemetry', () => {
        const result: AgentExecutionResult = {
          telemetry: {},
        };
        const error = {
          telemetry: {
            raw: {
              partialOutput: 'Incomplete execution output',
            },
          },
        };

        const output = extractOutput(result, error);

        expect(output).toBe('Incomplete execution output');
      });

      it('prefers result output over partial output', () => {
        const result: AgentExecutionResult = {
          output: 'Complete output',
          telemetry: {},
        };
        const error = {
          telemetry: {
            raw: {
              partialOutput: 'Partial output',
            },
          },
        };

        const output = extractOutput(result, error);

        expect(output).toBe('Complete output');
      });

      it('converts non-string partial output to string', () => {
        const result: AgentExecutionResult = {
          telemetry: {},
        };
        const error = {
          telemetry: {
            raw: {
              partialOutput: { incomplete: true },
            },
          },
        };

        const output = extractOutput(result, error);

        expect(output).toBe('[object Object]');
      });
    });

    describe('fallbacks', () => {
      it('returns empty string when no output', () => {
        const result: AgentExecutionResult = {
          telemetry: {},
        };

        const output = extractOutput(result);

        expect(output).toBe('');
      });

      it('returns empty string when result is null', () => {
        const output = extractOutput(null as any);

        expect(output).toBe('');
      });

      it('returns empty string when error has no partial output', () => {
        const result: AgentExecutionResult = {
          telemetry: {},
        };
        const error = {
          message: 'Error',
        };

        const output = extractOutput(result, error);

        expect(output).toBe('');
      });
    });
  });

  describe('mergeTelemetry', () => {
    describe('result telemetry precedence', () => {
      it('uses result telemetry when non-empty', () => {
        const result: AgentExecutionResult = {
          output: 'Done',
          telemetry: {
            duration: 5000,
            toolCalls: [],
          },
        };
        const error = {
          telemetry: {
            errorType: 'TIMEOUT',
          },
        };

        const merged = mergeTelemetry(result, error);

        expect(merged).toEqual(result.telemetry);
      });

      it('returns empty object when both are empty', () => {
        const result: AgentExecutionResult = {
          output: 'Done',
          telemetry: {},
        };
        const error = {
          telemetry: {},
        };

        const merged = mergeTelemetry(result, error);

        expect(merged).toEqual({});
      });
    });

    describe('error telemetry fallback', () => {
      it('uses error telemetry when result telemetry is empty', () => {
        const result: AgentExecutionResult = {
          output: 'Done',
          telemetry: {},
        };
        const error = {
          telemetry: {
            errorType: 'PROCESS_ERROR',
            partialData: {},
          },
        };

        const merged = mergeTelemetry(result, error);

        expect(merged).toEqual(error.telemetry);
      });

      it('uses error telemetry when result has no telemetry field', () => {
        const result: AgentExecutionResult = {
          output: 'Done',
        };
        const error = {
          telemetry: {
            duration: 3000,
          },
        };

        const merged = mergeTelemetry(result, error);

        expect(merged).toEqual(error.telemetry);
      });

      it('ignores non-object error telemetry', () => {
        const result: AgentExecutionResult = {
          output: 'Done',
          telemetry: {},
        };
        const error = {
          telemetry: 'invalid',
        };

        const merged = mergeTelemetry(result, error);

        expect(merged).toEqual({});
      });
    });

    describe('edge cases', () => {
      it('handles null result', () => {
        const merged = mergeTelemetry(null as any);

        expect(merged).toEqual({});
      });

      it('handles undefined error', () => {
        const result: AgentExecutionResult = {
          output: 'Done',
          telemetry: {
            duration: 5000,
          },
        };

        const merged = mergeTelemetry(result, undefined);

        expect(merged).toEqual(result.telemetry);
      });

      it('handles error without telemetry field', () => {
        const result: AgentExecutionResult = {
          output: 'Done',
          telemetry: {},
        };
        const error = {
          message: 'Error',
        };

        const merged = mergeTelemetry(result, error);

        expect(merged).toEqual({});
      });

      it('considers empty arrays as non-empty telemetry', () => {
        const result: AgentExecutionResult = {
          output: 'Done',
          telemetry: {
            toolCalls: [],
          },
        };
        const error = {
          telemetry: {
            errorType: 'TIMEOUT',
          },
        };

        const merged = mergeTelemetry(result, error);

        expect(merged).toEqual(result.telemetry);
      });

      it('considers zero values as non-empty telemetry', () => {
        const result: AgentExecutionResult = {
          output: 'Done',
          telemetry: {
            duration: 0,
            toolCalls: [],
          },
        };
        const error = {
          telemetry: {
            errorType: 'TIMEOUT',
          },
        };

        const merged = mergeTelemetry(result, error);

        expect(merged).toEqual(result.telemetry);
      });
    });
  });
});
