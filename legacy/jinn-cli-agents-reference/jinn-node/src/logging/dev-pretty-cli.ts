import pretty from 'pino-pretty';

const prettyStream = pretty({
  colorize: true,
  translateTime: 'SYS:standard',
  ignore: 'pid,hostname',
});

process.stdin.pipe(prettyStream);
