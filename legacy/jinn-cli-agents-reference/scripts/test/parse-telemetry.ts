#!/usr/bin/env npx tsx
/**
 * Parse Gemini CLI telemetry files and verify tool usage.
 *
 * Telemetry files contain concatenated JSON objects (not a JSON array).
 * This script uses a streaming brace-counting parser to extract them.
 *
 * Usage:
 *   yarn test:e2e:parse-telemetry <file>
 *   yarn test:e2e:parse-telemetry <file> --required-tools google_web_search,create_artifact
 *   yarn test:e2e:parse-telemetry /tmp/jinn-telemetry/telemetry-*.json
 *
 * Exit code:
 *   0 — all required tools were called (or no --required-tools specified)
 *   1 — one or more required tools were NOT called
 */

import { promises as fs } from 'fs';
import { glob } from 'glob';
import { parseAnnotatedTools } from '../../jinn-node/src/shared/template-tools.js';

// ─── Streaming JSON Parser ──────────────────────────────────────────────────
// Extracted from jinn-node/src/agent/agent.ts parseTelemetryFromContent()

function parseJsonObjects(content: string): any[] {
  const objects: any[] = [];
  let buffer = '';
  let started = false;
  let braceCount = 0;
  let inString = false;
  let escapeNext = false;
  let parseErrors = 0;

  for (let i = 0; i < content.length; i++) {
    const ch = content[i];

    if (!started) {
      if (ch === '{') {
        started = true;
        braceCount = 1;
        buffer = '{';
        inString = false;
        escapeNext = false;
      }
      continue;
    }

    buffer += ch;

    if (escapeNext) {
      escapeNext = false;
    } else if (ch === '\\' && inString) {
      escapeNext = true;
    } else if (ch === '"') {
      inString = !inString;
    } else if (!inString) {
      if (ch === '{') braceCount++;
      else if (ch === '}') braceCount--;
    }

    if (started && braceCount === 0) {
      const candidate = buffer.trim();
      try {
        objects.push(JSON.parse(candidate));
      } catch {
        parseErrors++;
      }
      started = false;
      buffer = '';
      inString = false;
      escapeNext = false;
    }
  }

  if (parseErrors > 0) {
    console.error(`  (${parseErrors} unparseable JSON fragments skipped)`);
  }

  return objects;
}

// ─── Event Processing ───────────────────────────────────────────────────────

interface ToolCall {
  tool: string;
  success: boolean;
  duration_ms: number;
  args?: string;
  businessOk?: boolean;
  businessCode?: string;
  businessMessage?: string;
}

interface TelemetryReport {
  coreToolsEnabled: string;
  model: string;
  toolCalls: ToolCall[];
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  eventCounts: Record<string, number>;
  eventCount: number;
}

function processEvents(events: any[]): TelemetryReport {
  const report: TelemetryReport = {
    coreToolsEnabled: '',
    model: '',
    toolCalls: [],
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    eventCounts: {},
    eventCount: events.length,
  };

  const requestTexts: string[] = [];

  for (const event of events) {
    if (!event?.attributes) continue;
    const attrs = event.attributes;
    const eventName = attrs['event.name'] || 'unknown';

    report.eventCounts[eventName] = (report.eventCounts[eventName] || 0) + 1;

    switch (eventName) {
      case 'gemini_cli.config':
        if (attrs['core_tools_enabled']) {
          report.coreToolsEnabled = attrs['core_tools_enabled'];
        }
        break;

      case 'gemini_cli.api_request':
        if (attrs['model']) report.model = attrs['model'];
        // Collect request_text for later functionResponse extraction
        if (attrs['request_text']) {
          requestTexts.push(attrs['request_text']);
        }
        break;

      case 'gemini_cli.api_response':
        if (typeof attrs['total_token_count'] === 'number') {
          report.totalTokens = Math.max(report.totalTokens, attrs['total_token_count']);
        }
        if (attrs['input_token_count']) {
          report.inputTokens += attrs['input_token_count'];
        }
        if (attrs['output_token_count']) {
          report.outputTokens += attrs['output_token_count'];
        }
        break;

      case 'gemini_cli.tool_call':
      case 'gemini_cli.function_call':
        report.toolCalls.push({
          tool: attrs['function_name'] || attrs['tool_name'] || attrs['name'] || 'unknown',
          success: attrs['success'] !== false,
          duration_ms: attrs['duration_ms'] || 0,
          args: String(attrs['function_args'] || attrs['parameters'] || attrs['args'] || '').substring(0, 120),
        });
        break;
    }
  }

  // Extract business-level results from functionResponse payloads in request_text.
  // Each request_text is a JSON array of conversation parts. functionResponse objects
  // contain the actual tool output (with meta.ok, meta.code, meta.message).
  const businessResults = new Map<string, { ok: boolean; code?: string; message?: string }>();

  for (const text of requestTexts) {
    try {
      const parsed = JSON.parse(text);
      // request_text is a conversation history: [{role, parts: [...]}, ...]
      const turns = Array.isArray(parsed) ? parsed : [parsed];
      for (const turn of turns) {
        const parts = turn?.parts || (turn?.functionResponse ? [turn] : []);
        for (const part of (Array.isArray(parts) ? parts : [])) {
          if (part?.functionResponse?.name && part?.functionResponse?.response?.output) {
            const name = part.functionResponse.name;
            try {
              const output = typeof part.functionResponse.response.output === 'string'
                ? JSON.parse(part.functionResponse.response.output)
                : part.functionResponse.response.output;
              if (output?.meta && typeof output.meta.ok === 'boolean') {
                // Record failures — a failure for any invocation means the tool failed
                const existing = businessResults.get(name);
                if (!existing || !output.meta.ok) {
                  businessResults.set(name, {
                    ok: output.meta.ok,
                    code: output.meta.code,
                    message: typeof output.meta.message === 'string'
                      ? output.meta.message.substring(0, 200)
                      : undefined,
                  });
                }
              }
            } catch { /* output not JSON — skip */ }
          }
        }
      }
    } catch { /* request_text not JSON — skip */ }
  }

  // Cross-reference tool calls with business-level results
  if (businessResults.size > 0) {
    for (const tc of report.toolCalls) {
      const biz = businessResults.get(tc.tool);
      if (biz) {
        tc.businessOk = biz.ok;
        tc.businessCode = biz.code;
        tc.businessMessage = biz.message;
      }
    }
  } else if (requestTexts.length === 0) {
    console.error('  WARNING: No request_text found in telemetry — business-level validation unavailable');
  }

  return report;
}

// ─── Output ─────────────────────────────────────────────────────────────────

function printReport(report: TelemetryReport, requiredTools: string[]): boolean {
  console.log('\n=== Telemetry Report ===\n');

  // Config
  console.log(`Model: ${report.model || '(not found)'}`);
  console.log(`Core tools enabled: ${report.coreToolsEnabled || '(not found)'}`);
  if (!report.coreToolsEnabled) {
    console.log('  WARNING: No core_tools_enabled — native tools may not have been configured');
  }

  // Token usage
  console.log(`\nTokens: input=${report.inputTokens}, output=${report.outputTokens}, total=${report.totalTokens}`);

  // Tool calls
  console.log(`\nTool calls (${report.toolCalls.length}):`);
  if (report.toolCalls.length === 0) {
    console.log('  (none)');
  } else {
    for (const tc of report.toolCalls) {
      let status: string;
      if (tc.businessOk === false) {
        status = `BIZ_FAIL:${tc.businessCode || 'UNKNOWN'}`;
      } else if (!tc.success) {
        status = 'FAIL';
      } else {
        status = 'OK';
      }
      console.log(`  ${tc.tool} [${status}] ${tc.duration_ms}ms`);
      if (tc.businessOk === false && tc.businessMessage) {
        console.log(`    response: ${tc.businessMessage}`);
      }
      if (tc.args) console.log(`    args: ${tc.args}`);
    }
  }

  // Required tool verification
  let allPassed = true;
  if (requiredTools.length > 0) {
    console.log('\nRequired tool verification:');
    const calledTools = new Set(report.toolCalls.map(tc => tc.tool));
    // Build a map of tool → worst business-level result (false overrides true)
    const toolBusinessStatus = new Map<string, { ok: boolean; code?: string }>();
    for (const tc of report.toolCalls) {
      if (tc.businessOk !== undefined) {
        const existing = toolBusinessStatus.get(tc.tool);
        if (!existing || !tc.businessOk) {
          toolBusinessStatus.set(tc.tool, { ok: tc.businessOk, code: tc.businessCode });
        }
      }
    }

    for (const required of requiredTools) {
      // Expand meta-tools (e.g. ventures_registry -> venture_query, venture_update, ...)
      // so verification reflects actual concrete function calls in telemetry.
      const candidates = parseAnnotatedTools([required]).availableTools;
      const matched = candidates.find(tool => calledTools.has(tool));
      const found = Boolean(matched);
      if (!found) {
        console.log(`  [FAIL] ${required} — not called`);
        allPassed = false;
      } else {
        // Check business-level success for the matched tool
        const biz = toolBusinessStatus.get(matched!);
        if (biz && !biz.ok) {
          const label = matched === required ? required : `${required} (via ${matched})`;
          console.log(`  [FAIL] ${label} — BIZ_FAIL:${biz.code || 'UNKNOWN'}`);
          allPassed = false;
        } else if (matched === required) {
          console.log(`  [PASS] ${required}`);
        } else {
          console.log(`  [PASS] ${required} (via ${matched})`);
        }
      }
    }
  }

  // Event summary
  console.log(`\nEvents parsed: ${report.eventCount}`);
  const sortedEvents = Object.entries(report.eventCounts).sort((a, b) => b[1] - a[1]);
  for (const [name, count] of sortedEvents) {
    console.log(`  ${name}: ${count}`);
  }

  console.log('');
  return allPassed;
}

// ─── CLI ────────────────────────────────────────────────────────────────────

function parseArgs(args: string[]): { files: string[]; requiredTools: string[] } {
  const files: string[] = [];
  const requiredTools: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--required-tools' && i + 1 < args.length) {
      requiredTools.push(...args[++i].split(',').map(t => t.trim()).filter(Boolean));
    } else if (!args[i].startsWith('--')) {
      files.push(args[i]);
    }
  }

  return { files, requiredTools };
}

async function main() {
  const { files: filePatterns, requiredTools } = parseArgs(process.argv.slice(2));

  if (filePatterns.length === 0) {
    console.error('Usage: parse-telemetry <file|glob> [--required-tools tool1,tool2]');
    process.exit(1);
  }

  // Resolve glob patterns
  const resolvedFiles: string[] = [];
  for (const pattern of filePatterns) {
    const matches = await glob(pattern);
    resolvedFiles.push(...matches);
  }

  if (resolvedFiles.length === 0) {
    console.error(`No files matched: ${filePatterns.join(', ')}`);
    process.exit(1);
  }

  // Read and concatenate all files
  let allContent = '';
  for (const file of resolvedFiles) {
    console.log(`Reading: ${file}`);
    const content = await fs.readFile(file, 'utf-8');
    allContent += content;
  }

  console.log(`Total content: ${(allContent.length / 1024).toFixed(1)} KB`);

  // Parse
  const events = parseJsonObjects(allContent);
  console.log(`Parsed ${events.length} telemetry events`);

  if (events.length === 0) {
    console.error('ERROR: No telemetry events found');
    process.exit(1);
  }

  // Process and report
  const report = processEvents(events);
  const allPassed = printReport(report, requiredTools);

  if (requiredTools.length > 0 && !allPassed) {
    process.exit(1);
  }
}

main().catch(e => {
  console.error('FAILED:', e.message || e);
  process.exit(1);
});
