import type { DesiredState, RestorationResult, RequestId } from '../types/index.js';

export interface RunnerContext {
  requestId: RequestId;
  workingDirectory: string;
  timeoutMs: number;
  // TODO: Add mcpServer: McpServer when MCP server is implemented
}

export interface Runner {
  run(desiredState: DesiredState, context: RunnerContext): Promise<RestorationResult>;
}
