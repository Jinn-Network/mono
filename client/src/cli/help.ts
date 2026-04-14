import type { CommandModule } from './command.js';

export function renderTopLevelHelp(commands: CommandModule[]): string {
  const lines: string[] = [];
  lines.push('Usage: jinn <verb> [flags...]');
  lines.push('');
  lines.push('Verbs:');
  const visible = commands.filter(c => c.name !== 'fleet-manage');
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
  lines.push('Run `jinn <verb> --help` for verb-specific flags and examples.');
  return lines.join('\n');
}

export function renderCommandHelp(command: CommandModule): string {
  return `jinn ${command.name} — ${command.summary}\n\n${command.helpText}`;
}
