# MCP Server

This directory contains the Model Context Protocol (MCP) server implementation for the Jinn agent system.

## Overview

The MCP server provides tools for:
- Job management (dispatch, search, finalize)
- Artifact creation and search
- File operations (read, search code)
- Git operations (list commits)

## Logging Architecture

**CRITICAL**: The MCP server uses stdout for JSON-RPC communication. Any non-JSON-RPC output on stdout will corrupt the protocol stream and cause client errors.

### Stdout Protection

The server implements multiple layers of protection:

1. **FORCE_STDERR Environment Variable**: Set on server startup
   - Forces all Pino logs to stderr (configured in `logging/index.ts`)
   - This is always set since this entry point is exclusively for MCP protocol

2. **Console Method Overrides**: Console methods are redirected in `server.ts:main()`
   - `console.log` → noop
   - `console.info` → noop
   - `console.debug` → noop (unless MCP_LOG_LEVEL=debug)
   - `console.warn` → stderr
   - `console.error` → stderr (already goes to stderr by default)

3. **Test Coverage**: `tests/unit/mcp-stdout-clean.test.ts` validates stdout cleanliness
   - Spawns MCP server with VITEST=true (forces JSON logging)
   - Verifies stdout contains only valid JSON-RPC messages
   - Confirms Pino logs appear on stderr, not stdout

### Logging Configuration

The MCP server sets `FORCE_STDERR=true` on startup, causing the logging module to redirect all Pino output to stderr:

```typescript
// gemini-agent/mcp/server.ts
async function main() {
  process.env.FORCE_STDERR = 'true'; // Force stderr for all logs
  // ...
}

// logging/index.ts
function createLogger(): pino.Logger {
  const forceStderr = process.env.FORCE_STDERR === 'true';
  const destination = forceStderr ? pino.destination({ dest: 2, sync: false }) : undefined;
  // ...
}
```

### Testing

Run the stdout cleanliness test:

```bash
yarn vitest run tests/unit/mcp-stdout-clean.test.ts
```

This test:
1. Spawns the MCP server
2. Sends an initialize request
3. Verifies all stdout lines are valid JSON-RPC (no Pino logs)
4. Confirms Pino logs appear on stderr

### Troubleshooting

If you see errors like:

```
MCP error: invalid_literal ... expected "2.0"
```

This indicates stdout pollution. Check:

1. Are you using `console.log` after server startup? Use stderr instead:
   ```typescript
   console.error('my message'); // OK - goes to stderr
   console.log('my message');   // BAD - pollutes stdout
   ```

2. Is a third-party library logging to stdout? Redirect it:
   ```typescript
   someLibrary.setLogger({ write: (msg) => console.error(msg) });
   ```

3. Run the stdout cleanliness test to isolate the issue:
   ```bash
   yarn vitest run tests/unit/mcp-stdout-clean.test.ts
   ```

## Development

### Starting the Server

```bash
tsx gemini-agent/mcp/server.ts
```

### Environment Variables

- `FORCE_STDERR=true` - Set automatically on startup; forces stderr logging
- `MCP_LOG_LEVEL` - Log level (error, warn, info, debug); defaults to 'error'
- `LOG_LEVEL` - Pino log level (used if MCP_LOG_LEVEL not set)
- `VITEST=true` - Forces JSON logging (used in tests)

### Adding New Tools

1. Define schema in `gemini-agent/mcp/tools/[tool-name].ts`
2. Export from `gemini-agent/mcp/tools/index.ts`
3. Register in `server.ts:main()` serverTools array
4. Document in tool JSDoc comments

## Architecture

```
gemini-agent/mcp/
├── server.ts           # MCP server entry point
├── tools/              # Tool implementations
│   ├── index.ts        # Tool exports
│   ├── shared/         # Shared utilities
│   └── [tools].ts      # Individual tool implementations
└── README.md           # This file
```

## Protocol

The server implements the [Model Context Protocol](https://modelcontextprotocol.io/) specification version 2024-11-05.

Communication format:
- **Transport**: stdio (stdin/stdout)
- **Encoding**: JSON-RPC 2.0
- **Message Format**: One JSON object per line

Example request:
```json
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"dispatch_new_job","arguments":{"objective":"Build feature X"}}}
```

Example response:
```json
{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"Job created: job-123"}]}}
```
