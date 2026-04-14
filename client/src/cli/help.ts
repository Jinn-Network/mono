import type { CommandModule } from './command.js';

export function renderTopLevelHelp(commands: CommandModule[]): string {
  const lines: string[] = [];
  lines.push('Usage: jinn <verb> [flags...]');
  lines.push('');
  lines.push('Verbs:');
  const invocations = commands.map((c) => `jinn ${c.name}`);
  const maxInvocationLen = Math.max(...invocations.map((s) => s.length));
  for (const cmd of commands) {
    const invocation = `jinn ${cmd.name}`;
    lines.push(`  ${invocation.padEnd(maxInvocationLen)}  ${cmd.summary}`);
  }
  lines.push('');
  lines.push('Run `jinn <verb> --help` for verb-specific flags and examples.');
  return lines.join('\n');
}

export function renderCommandHelp(command: CommandModule): string {
  return `jinn ${command.name} — ${command.summary}\n\n${command.helpText}`;
}
