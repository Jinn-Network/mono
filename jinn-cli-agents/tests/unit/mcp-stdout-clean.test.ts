/**
 * Test: MCP server stdout should only contain JSON-RPC messages
 *
 * Verifies that Pino logs don't pollute stdout when MCP server is running.
 * All logs should go to stderr, leaving stdout clean for JSON-RPC protocol.
 */

import { describe, it, expect } from 'vitest';
import { spawn } from 'child_process';
import { join } from 'path';

describe('MCP Server Stdout Cleanliness', () => {
  it('stdout contains only valid JSON-RPC messages, no Pino logs', async () => {
    const serverPath = join(process.cwd(), 'gemini-agent/mcp/server.ts');

    // Spawn MCP server
    const proc = spawn('tsx', [serverPath], {
      env: {
        ...process.env,
        VITEST: 'true', // Forces JSON logging
        LOG_LEVEL: 'debug', // Verbose to ensure logs would appear if not redirected
        MCP_FORCE_DIAGNOSTIC_LOG: 'true',
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    // Send initialize request
    const initRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' }
      }
    };

    proc.stdin.write(JSON.stringify(initRequest) + '\n');

    // Wait for response
    await new Promise(resolve => setTimeout(resolve, 2000));

    proc.kill();

    // Parse stdout line by line
    const stdoutLines = stdout.split('\n').filter(line => line.trim());

    for (const line of stdoutLines) {
      // Each line should be valid JSON with jsonrpc: "2.0"
      try {
        const parsed = JSON.parse(line);
        expect(parsed.jsonrpc).toBe('2.0');

        // Should NOT have Pino fields like level, time, component
        expect(parsed).not.toHaveProperty('level');
        expect(parsed).not.toHaveProperty('time');
        expect(parsed).not.toHaveProperty('component');
        expect(parsed).not.toHaveProperty('pid');
        expect(parsed).not.toHaveProperty('hostname');
      } catch (e) {
        // If it's not valid JSON, fail the test
        throw new Error(`stdout contained non-JSON line: ${line}`);
      }
    }

    // Pino logs should appear in stderr, including our diagnostic probe
    const stderrLines = stderr.split('\n').filter(line => line.trim());
    expect(stderrLines.length).toBeGreaterThan(0);

    const parsedStderr = stderrLines.map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Error(`stderr contained non-JSON line: ${line}`);
      }
    });

    const probeLog = parsedStderr.find(
      (entry) => entry.msg === 'MCP stdout cleanliness test probe' && entry.diagnostic === true
    );
    expect(probeLog).toBeTruthy();
    expect(probeLog.level).toBeDefined();

    // Main assertion: stdout should have at least one valid JSON-RPC message
    expect(stdoutLines.length).toBeGreaterThan(0);
  }, 10000);
});
