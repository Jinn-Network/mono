/**
 * `jinn ceremony` takes each flag only on the verbs that read it (issue #5364).
 *
 * Every verb parses against one option table, so a flag meant for one verb used to be accepted by
 * the others and ignored without a word. These are key-custody commands: an operator who passed
 * `--retiring-store` to init, or `--genesis` to rotate, had no sign the flag did nothing. Each verb
 * now refuses such a flag before it reads any store, catalog or chain state, naming the flag, the
 * verb, and the verbs that take it.
 *
 * `CEREMONY_FLAG_VERBS` is typed against the parser's option table, so a new flag does not compile
 * until it names the verbs that take it; the walk below then holds every verb to that decision, and
 * the help tests hold the help's option list to it.
 */
import { mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  CEREMONY_FLAG_VERBS,
  CEREMONY_VERBS,
  createCeremonyCommand,
  type CeremonyCommandDeps,
} from '../../src/cli/commands/ceremony.js';
import type { CommandContext } from '../../src/cli/command.js';

const PASSWORD = 'ceremony-flags-test-password';
const GENESIS = `sha256:${'a'.repeat(64)}`;

type Verb = (typeof CEREMONY_VERBS)[number];
type Flag = keyof typeof CEREMONY_FLAG_VERBS;

interface Harness {
  readonly home: string;
  readonly dir: string;
  readonly authorityStore: string;
  readonly catalog: string;
  readonly deps: CeremonyCommandDeps;
  /** Every chain-touching dep the command reached. */
  readonly calls: string[];
}

/** Deps that record each call and fail it: a refused flag must reach none of them. */
function harness(): Harness {
  const home = mkdtempSync(join(tmpdir(), 'ceremony-flags-'));
  const dir = join(home, '.jinn-operator');
  mkdirSync(dir, { recursive: true });
  const calls: string[] = [];
  const reached = (name: string): never => {
    calls.push(name);
    throw new Error(`${name} reached`);
  };
  return {
    home,
    dir,
    authorityStore: join(home, '.jinn-ceremony', 'authority.enc.json'),
    catalog: join(home, 'trust.json'),
    calls,
    deps: {
      async readChainCustody() { return reached('readChainCustody'); },
      async verifySafeOwnership() { return reached('verifySafeOwnership'); },
      async openAnchorSession() { return reached('openAnchorSession'); },
      async readAnchorStatus() { return reached('readAnchorStatus'); },
    },
  };
}

/** Every file and directory under `root`, relative to it. */
function tree(root: string): string[] {
  return readdirSync(root, { recursive: true, encoding: 'utf-8' })
    .map((entry) => relative(root, join(root, entry)))
    .sort();
}

async function run(h: Harness, argv: string[]) {
  const writes: string[] = [];
  const exits: number[] = [];
  const ctx: CommandContext = {
    argv,
    stdoutIsTty: false,
    writer: { write: (text: string) => { writes.push(text); return true; } },
    exit: (code: number) => { exits.push(code); },
    env: { HOME: h.home, JINN_PASSWORD: PASSWORD } as NodeJS.ProcessEnv,
  };
  await createCeremonyCommand(h.deps).run(ctx);
  const envelopes = writes.flatMap((line) => {
    try {
      return [JSON.parse(line) as Record<string, unknown>];
    } catch {
      return [];
    }
  });
  return { writes, exits, envelopes, last: envelopes[envelopes.length - 1] };
}

/** A full invocation of each verb, `--execute` included where the verb takes it. */
function verbArgv(h: Harness, verb: Verb): string[] {
  switch (verb) {
    case 'init':
      return ['init', '--dir', h.dir, '--role-sets', 'requester,solver', '--authority-store', h.authorityStore, '--execute'];
    case 'join':
      return [
        'join', '--dir', h.dir, '--role-sets', 'requester,solver', '--catalog', h.catalog,
        '--genesis', GENESIS, '--authority-store', h.authorityStore, '--execute',
      ];
    case 'rotate':
      return ['rotate', '--dir', h.dir, '--role-sets', 'solver', '--execute'];
    case 'show':
      return ['show', '--dir', h.dir, '--catalog', h.catalog];
  }
}

const BOOLEAN_FLAGS: ReadonlySet<string> = new Set(['execute', 'dry-run', 'resubmit-anchor', 'json', 'human', 'help']);

/** The flag as an operator would pass it, with a well-formed value where it takes one. */
function flagArgs(h: Harness, flag: string): string[] {
  const option = `--${flag}`;
  if (BOOLEAN_FLAGS.has(flag)) return [option];
  switch (flag) {
    case 'role-sets': return [option, 'solver'];
    case 'retiring-store': return [option, `solver=${join(h.dir, 'identity', 'solver.enc.json')}`];
    case 'genesis': return [option, GENESIS];
    case 'service-index': return [option, '1'];
    case 'anchor-target': return [option, `0x${'11'.repeat(20)}`];
    case 'finality-timeout-ms': return [option, '1000'];
    case 'rpc-url': return [option, 'http://127.0.0.1:8545'];
    case 'password-fd': return [option, '0'];
    default: return [option, join(h.home, `${flag}.json`)];
  }
}

/** Asserts the run refused exactly `flags` for `verb`, and reached nothing. */
function expectRefused(
  h: Harness,
  before: readonly string[],
  result: Awaited<ReturnType<typeof run>>,
  verb: Verb,
  flags: readonly { readonly flag: string; readonly takenBy: readonly string[] }[],
): void {
  const label = `${verb} ${flags.map(({ flag }) => flag).join(' ')}`;
  expect(result.envelopes, label).toHaveLength(1);
  expect(result.exits, label).toHaveLength(1);
  const refusal = result.last!;
  expect(refusal.code, label).toBe('invalid_invocation');
  expect(refusal.details, label).toEqual({
    feature: 'ceremony',
    state: 'unused-flag',
    verb,
    flags,
    sideEffects: false,
  });
  const message = String(refusal.message);
  expect(message, label).toContain(`ceremony ${verb}`);
  for (const { flag, takenBy } of flags) {
    expect(message, label).toContain(flag);
    for (const taker of takenBy) expect(message, label).toContain(taker);
  }
  // Nothing read, minted, anchored or written.
  expect(h.calls, label).toEqual([]);
  expect(tree(h.home), label).toEqual(before);
}

describe('ceremony verbs refuse the flags they do not take (issue #5364)', () => {
  /** The pairs the issue names: init and join take neither rotate flag; rotate takes no init or join flag; show takes none. */
  const ISSUE_PAIRS: readonly (readonly [Verb, string, readonly string[]])[] = [
    ['init', '--retiring-store', ['rotate']],
    ['join', '--retiring-store', ['rotate']],
    ['show', '--retiring-store', ['rotate']],
    ['init', '--resubmit-anchor', ['rotate']],
    ['join', '--resubmit-anchor', ['rotate']],
    ['show', '--resubmit-anchor', ['rotate']],
    ['rotate', '--authority-store', ['init', 'join']],
    ['rotate', '--genesis', ['join']],
    ['rotate', '--previous-catalog', ['init']],
    ['show', '--authority-store', ['init', 'join']],
    ['show', '--genesis', ['join']],
    ['show', '--previous-catalog', ['init']],
  ];

  it.each(ISSUE_PAIRS)('%s refuses %s before anything is read, minted or anchored', async (verb, flag, takenBy) => {
    const h = harness();
    const before = tree(h.home);
    const result = await run(h, [...verbArgv(h, verb), ...flagArgs(h, flag.slice(2))]);
    expectRefused(h, before, result, verb, [{ flag, takenBy }]);
  });

  it('names every flag the verb does not take, once each, in the order given', async () => {
    const h = harness();
    const before = tree(h.home);
    const result = await run(h, [
      ...verbArgv(h, 'rotate'),
      ...flagArgs(h, 'genesis'),
      ...flagArgs(h, 'authority-store'),
      ...flagArgs(h, 'genesis'),
    ]);
    expectRefused(h, before, result, 'rotate', [
      { flag: '--genesis', takenBy: ['join'] },
      { flag: '--authority-store', takenBy: ['init', 'join'] },
    ]);
    expect(String(result.last!.message)).toBe(
      'ceremony rotate does not take --genesis (only join takes it) or --authority-store (only init and join take it)',
    );
  });

  it('walks the whole table: each verb takes exactly the flags listed for it and refuses every other', async () => {
    const flags = Object.keys(CEREMONY_FLAG_VERBS) as Flag[];
    expect(flags.length).toBeGreaterThan(0);
    for (const flag of flags) {
      const takers: readonly string[] = CEREMONY_FLAG_VERBS[flag];
      expect(takers.length, `--${flag} names no verb`).toBeGreaterThan(0);
      for (const verb of CEREMONY_VERBS) {
        const h = harness();
        const before = tree(h.home);
        // eslint-disable-next-line no-await-in-loop -- one isolated run per (flag, verb) pair.
        const result = await run(h, [verb, '--dir', h.dir, ...(flag === 'dir' ? [] : flagArgs(h, flag))]);
        if (takers.includes(verb)) {
          const refusedAsUnused = result.envelopes.some((envelope) =>
            (envelope.details as { state?: unknown } | undefined)?.state === 'unused-flag');
          expect(refusedAsUnused, `${verb} takes --${flag}`).toBe(false);
        } else {
          expectRefused(h, before, result, verb, [{ flag: `--${flag}`, takenBy: [...takers] }]);
        }
      }
    }
  });
});

describe('ceremony help matches the flag table', () => {
  const help = createCeremonyCommand(harness().deps).helpText;

  /** The option entries: each `  --flag ...` line with its continuation lines. */
  function optionEntries(): { readonly flag: string; readonly verbs: readonly string[] }[] {
    const start = help.indexOf('\nOptions');
    const end = help.indexOf('\nConfig write-back:');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const section = help.slice(start, end);
    return section.split(/\n(?= {2}--)/u).slice(1).map((entry) => {
      const head = /^ {2}--([a-z-]+)(?: <\S+)?\s+/u.exec(entry);
      expect(head, entry).not.toBeNull();
      const description = entry.slice(head![0].length);
      const marked = /^((?:init|join|rotate|show)(?:(?:, | and )(?:init|join|rotate|show))*) only\b/u.exec(description);
      return {
        flag: head![1]!,
        verbs: marked === null ? [...CEREMONY_VERBS] : marked[1]!.split(/, | and /u),
      };
    });
  }

  it('describes each flag once, marked with exactly the verbs the table gives it (unmarked: every verb)', () => {
    const entries = optionEntries();
    expect(entries.map(({ flag }) => flag).sort()).toEqual(Object.keys(CEREMONY_FLAG_VERBS).sort());
    for (const { flag, verbs } of entries) {
      expect(verbs, `--${flag}`).toEqual([...CEREMONY_FLAG_VERBS[flag as Flag]]);
    }
  });

  it('shows each verb only with flags it takes in its usage and example lines', () => {
    const lines = help.split('\n').filter((line) => /jinn ceremony (init|join|rotate|show)\b/u.test(line)
      && /^\s*(?:JINN_PASSWORD=\S+ )?jinn ceremony /u.test(line));
    expect(lines.length).toBeGreaterThanOrEqual(8);
    for (const line of lines) {
      const verb = /jinn ceremony (init|join|rotate|show)\b/u.exec(line)![1] as Verb;
      for (const [, flag] of line.matchAll(/--([a-z-]+)/gu)) {
        expect(CEREMONY_FLAG_VERBS[flag as Flag] as readonly string[] | undefined, `${line}: --${flag}`)
          .toContain(verb);
      }
    }
  });
});
