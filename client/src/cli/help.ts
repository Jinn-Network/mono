import type { CommandModule } from './command.js';

export function renderTopLevelHelp(commands: CommandModule[]): string {
  const lines: string[] = [];
  lines.push('Usage: jinn <verb> [flags...]');
  lines.push('');
  lines.push('Verbs:');
  const maxNameLen = Math.max(...commands.map((c) => c.name.length));
  for (const cmd of commands) {
    lines.push(`  ${cmd.name.padEnd(maxNameLen)}  ${cmd.summary}`);
  }
  lines.push('');
  lines.push('Run `jinn <verb> --help` for verb-specific flags and examples.');
  return lines.join('\n');
}

export function renderCommandHelp(command: CommandModule): string {
  return `jinn ${command.name} — ${command.summary}\n\n${command.helpText}`;
}
