import pino from 'pino';

export type LoggingConfig = {
  level: pino.Level;
  destination: 'stdout' | string;
  format: 'json' | 'pretty';
};

const VALID_LEVELS: pino.Level[] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];

function resolveLogLevel(): pino.Level {
  const level = process.env.LOG_LEVEL?.toLowerCase();

  if (level && (VALID_LEVELS as readonly string[]).includes(level)) {
    return level as pino.Level;
  }

  return process.env.NODE_ENV === 'test' ? 'warn' : 'info';
}

function resolveFormat(): 'json' | 'pretty' {
  const rawFormat = process.env.LOG_FORMAT?.trim().toLowerCase();
  const prettyFlag = (process.env.LOG_PRETTY || '').trim().toLowerCase();

  if (!rawFormat) {
    return prettyFlag === '1' || prettyFlag === 'true' ? 'pretty' : 'json';
  }

  if (rawFormat === 'json') return 'json';
  if (rawFormat === 'pretty') return 'pretty';

  throw new Error('LOG_FORMAT must be "json" or "pretty" to match the unified logging pipeline.');
}

function resolveDestination(): 'stdout' | string {
  const destination = process.env.LOG_DESTINATION?.trim();
  if (!destination || destination === 'stdout') {
    return 'stdout';
  }

  if (destination === 'stderr') {
    return 'stderr';
  }

  return destination;
}

export function getLoggingConfig(): LoggingConfig {
  const level = resolveLogLevel();
  const destination = resolveDestination();
  const format = resolveFormat();

  return {
    level,
    destination,
    format,
  };
}
