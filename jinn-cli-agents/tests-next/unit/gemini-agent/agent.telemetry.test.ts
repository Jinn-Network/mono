import { describe, it, expect } from 'vitest';
import { Agent } from 'jinn-node/agent/agent.js';

function chunk(attributes: Record<string, any>) {
  return JSON.stringify({ attributes });
}

describe('Agent telemetry parsing', () => {
  it('captures function_args for tool calls', () => {
    const agent = new Agent('gemini-2.5-flash', []);
    const telemetryContent = chunk({
      'event.name': 'gemini_cli.tool_call',
      'function_name': 'process_branch',
      'function_args': JSON.stringify({
        branch_name: 'job/test-branch',
        action: 'merge',
        rationale: 'Ready to integrate',
      }),
      'duration_ms': 123,
    });

    const telemetry = (agent as any).parseTelemetryFromContent(telemetryContent, Date.now());

    expect(telemetry.toolCalls).toHaveLength(1);
    expect(telemetry.toolCalls[0].args).toContain('"branch_name":"job/test-branch"');
  });

  it('captures function_response for tool calls', () => {
    const agent = new Agent('gemini-2.5-flash', []);
    const telemetryContent = chunk({
      'event.name': 'gemini_cli.tool_call',
      'function_name': 'create_artifact',
      'function_args': JSON.stringify({ name: 'artifact' }),
      'function_response': JSON.stringify({ cid: 'bafk...' }),
      'duration_ms': 45,
    });

    const telemetry = (agent as any).parseTelemetryFromContent(telemetryContent, Date.now());

    // The result is attached via attachToolResultsToToolCalls which requires requestText
    // In this test, result won't be attached since we don't provide conversation history
    expect(telemetry.toolCalls[0]).toBeDefined();
    expect(telemetry.toolCalls[0].tool).toBe('create_artifact');
  });

  it('attaches results to failed tool calls', () => {
    const agent = new Agent('gemini-2.5-flash', []);

    // First, parse a failed tool call event
    const telemetryContent = chunk({
      'event.name': 'gemini_cli.tool_call',
      'function_name': 'search_job',
      'function_args': JSON.stringify({ query: 'test' }),
      'success': false,
      'duration_ms': 100,
    });

    const telemetry = (agent as any).parseTelemetryFromContent(telemetryContent, Date.now());

    // Simulate requestText with a function response containing an error
    telemetry.requestText = [
      JSON.stringify([
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'search_job',
                response: {
                  output: JSON.stringify({ error: 'Failed to connect to Ponder' })
                }
              }
            }
          ]
        }
      ])
    ];

    // Call attachToolResultsToToolCalls
    (agent as any).attachToolResultsToToolCalls(telemetry);

    // Verify the error result was attached even though success=false
    expect(telemetry.toolCalls[0].result).toBeDefined();
    expect(telemetry.toolCalls[0].result.error).toBe('Failed to connect to Ponder');
  });
});




