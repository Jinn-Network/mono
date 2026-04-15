import pino from 'pino';
import { SonicBoom } from 'sonic-boom';
import { getLoggingConfig, LoggingConfig } from './config.js';

export type LoggerBundle = {
  logger: pino.Logger;
  flush: () => Promise<void>;
  destination: SonicBoom | null;
};

function createDestination(destination: LoggingConfig['destination']): SonicBoom {
  if (destination === 'stdout') {
    return pino.destination({ dest: 1, sync: false });
  }

  if (destination === 'stderr') {
    return pino.destination({ dest: 2, sync: false });
  }

  return pino.destination({
    dest: destination,
    append: true,
    sync: false,
  });
}

function flushDestination(destination: SonicBoom): Promise<void> {
  if (typeof destination.flushSync === 'function') {
    destination.flushSync();
    return Promise.resolve();
  }

  if (typeof destination.flush === 'function') {
    return new Promise<void>((resolve, reject) => {
      destination.flush((err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  return Promise.resolve();
}

export function buildLogger(config: LoggingConfig = getLoggingConfig()): LoggerBundle {
  const forceStderr = process.env.FORCE_STDERR === 'true';
  const destinationTarget = forceStderr ? 'stderr' : config.destination;
  const baseOptions = {
    level: config.level,
    formatters: {
      level: (label: string) => ({ level: label }),
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  };

  if (config.format === 'pretty') {
    const transport = pino.transport({
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
        destination: destinationTarget === 'stderr' ? 2 : 1,
      },
    });

    return {
      logger: pino(baseOptions, transport),
      destination: null,
      flush: async () => {},
    };
  }

  const destination = createDestination(destinationTarget);
  return {
    logger: pino(baseOptions, destination),
    destination,
    flush: () => flushDestination(destination),
  };
}
