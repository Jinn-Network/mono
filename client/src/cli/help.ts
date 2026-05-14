import type { CommandModule } from './command.js';

export function renderTopLevelHelp(commands: CommandModule[]): string {
  const lines: string[] = [];
  lines.push('Usage: jinn <verb> [flags...]');
  lines.push('');
  lines.push('Output: operational verbs emit JSON on stdout by default.');
  lines.push('Use `--human` for readable terminal output. Help stays human-readable.');
  lines.push('');
  lines.push('Verbs:');
  const visible = commands.filter(c => !['fleet-manage', 'auth', 'quickstart'].includes(c.name));
  const invocations = visible.map(c => `jinn ${c.name}`);
  const maxInvocationLen =
    invocations.length > 0 ? Math.max(...invocations.map(s => s.length)) : 1;
  for (const cmd of visible) {
    const invocation = `jinn ${cmd.name}`;
    lines.push(`  ${invocation.padEnd(maxInvocationLen)}  ${cmd.summary}`);
  }
  lines.push('');
  lines.push('Additional subverbs:');
  lines.push('  fleet scale --to N                    Grow or shrink the fleet');
  lines.push('  fleet retire <index>                  Retire one service');
  lines.push('');
  lines.push('Operator map:');
  lines.push('  New operator: install the client, then run `jinn run`.');
  lines.push('');
  lines.push('  First run:');
  lines.push('  jinn run                              Open the app, init, bootstrap, start daemon');
  lines.push('                                        Complete Claude/runtime setup in the app if prompted');
  lines.push('');
  lines.push('  Day-to-day:');
  lines.push('  jinn run                              Start the daemon or fail with a structured next step');
  lines.push('  jinn doctor                           Check environment and config readiness');
  lines.push('  jinn fund-requirements                Show exact funding gaps');
  lines.push('  jinn status                           Poll health; use this for monitoring');
  lines.push('  jinn fleet|balance|history|rewards    Inspect current state and history');
  lines.push('  jinn tasks|claim-rewards              Execute protocol actions');
  lines.push('  jinn withdraw|keys backup             Move funds or back up the mnemonic');
  lines.push('');
  lines.push('Run `jinn <verb> --help` for verb-specific flags and examples.');
  return lines.join('\n');
}

export function renderCommandHelp(command: CommandModule): string {
  const label = command.name === 'fleet-manage' ? 'fleet' : command.name;
  return `jinn ${label} — ${command.summary}\n\n${command.helpText}`;
}
