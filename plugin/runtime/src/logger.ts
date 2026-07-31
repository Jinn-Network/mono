// SPDX-License-Identifier: Apache-2.0

export type LogLevel = "silent" | "error" | "warn" | "info" | "debug";

export interface RuntimeLogger {
  debug(message: string, fields?: Readonly<Record<string, unknown>>): void;
  info(message: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(message: string, fields?: Readonly<Record<string, unknown>>): void;
  error(message: string, fields?: Readonly<Record<string, unknown>>): void;
}

const SEVERITY: Readonly<Record<LogLevel, number>> = Object.freeze({
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
});

type EmittedLevel = Exclude<LogLevel, "silent">;

function serializeField(value: unknown): unknown {
  try {
    JSON.stringify(value);
    return value;
  } catch {
    return "[unserializable]";
  }
}

/**
 * A structured line logger over an injected sink. The sink is injected so nothing in this
 * package reaches for a real stream: the binary owns stderr, and stdout stays reserved
 * for the MCP stdio transport.
 */
export function createLineLogger(
  level: LogLevel,
  write: (line: string) => void,
): RuntimeLogger {
  const threshold = SEVERITY[level];

  const emit = (
    entryLevel: EmittedLevel,
    message: string,
    fields?: Readonly<Record<string, unknown>>,
  ): void => {
    if (SEVERITY[entryLevel] > threshold) return;
    const record: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fields ?? {})) {
      if (key === "level" || key === "message") continue;
      record[key] = serializeField(value);
    }
    record.level = entryLevel;
    record.message = message;
    write(JSON.stringify(record));
  };

  return {
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
  };
}

/** A logger that discards every record. Useful as a default and in tests. */
export function createSilentLogger(): RuntimeLogger {
  return createLineLogger("silent", () => {});
}
