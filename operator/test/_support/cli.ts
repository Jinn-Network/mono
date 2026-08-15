import type { CommandContext, CommandModule } from '@/cli/command.js';

export interface MakeCommandCtxOpts {
  argv?: string[];
  env?: Record<string, string>;
  tty?: boolean;
}

export interface MadeCtx {
  ctx: CommandContext;
  writes: string[];
  exits: number[];
}

/**
 * Canonical replacement for the ~15 ad-hoc `makeCtx` helpers across test/cli/.
 * Produces a CommandContext with captured writer+exit, plus the write/exit buffers.
 */
export function makeCommandCtx(opts: MakeCommandCtxOpts = {}): MadeCtx {
  const writes: string[] = [];
  const exits: number[] = [];
  const ctx: CommandContext = {
    argv: opts.argv ?? [],
    stdoutIsTty: opts.tty ?? false,
    writer: { write: (s: string) => { writes.push(s); return true; } },
    exit: (code: number) => { exits.push(code); },
    env: opts.env ?? {},
  };
  return { ctx, writes, exits };
}

export interface RanCommand {
  envelopes: unknown[];
  exits: number[];
  raw: string[];
}

/**
 * Runs a command module and returns captured stdout parsed as one JSON envelope
 * per non-empty write. Non-JSON writes are tolerated (they appear in `raw` but not
 * in `envelopes`). Commands that write partial lines across multiple calls are
 * joined before splitting on newlines.
 */
export async function runCommand(
  cmd: CommandModule,
  opts: MakeCommandCtxOpts = {},
): Promise<RanCommand> {
  const made = makeCommandCtx(opts);
  await cmd.run(made.ctx);
  const joined = made.writes.join('');
  const lines = joined.split('\n').map(l => l.trim()).filter(Boolean);
  const envelopes: unknown[] = [];
  for (const line of lines) {
    if (line.startsWith('{') || line.startsWith('[')) {
      try { envelopes.push(JSON.parse(line)); } catch { /* not JSON; skip */ }
    }
  }
  return { envelopes, exits: made.exits, raw: made.writes };
}
