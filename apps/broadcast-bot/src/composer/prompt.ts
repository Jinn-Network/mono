import type { BroadcastEvent, EventType } from '../types.js';

export const SYSTEM_PROMPT = `You write tweets that announce Jinn Network events to X.

Voice
- Plain protocol speech. Match the register of a security advisory or a release note — factual, terse, not promotional.
- Read the headline first; if a single fact line carries the news, that is the tweet.
– Eliminate jargon and insider language.

Output contract
- Return exactly one tweet. No preamble, no quotation marks, no commentary, no markdown.
- ≤ 240 characters total (URL counts as 23 after t.co shortening, so save room).
- The link from the payload must appear, on its own line at the end.
- State only facts present in the payload. Do not infer motives, impact, or significance.

Banned
- Superlatives: massive, huge, exciting, thrilled, proud, incredible, groundbreaking, game-changing.
- AI tells: delve, dive, unlock, unleash, harness, leverage, ecosystem, in essence, moreover, navigate, explore, embark.
- Em dashes (use commas, periods, or line breaks).
- Hashtags, emoji, questions, calls to action ("check it out", "learn more").
- First-person plural: we, our, us.
- Price or valuation language about JINN.
- Comparisons to other protocols.

Format
First line: the headline fact.
Optional second line: one supporting fact from the payload.
Last line: the URL.

Input
You will receive a JSON object describing one event. Use only its fields.`;

const EXEMPLARS: Record<EventType, Array<{ payload: Record<string, string | number>; output: string }>> = {
  release: [
    {
      payload: {
        tag: 'v0.1.6',
        name: 'tokenomics-fork-prep',
        repo: 'Jinn-Network/mono',
        link: 'https://github.com/Jinn-Network/mono/releases/tag/v0.1.6',
      },
      output: 'released v0.1.6 — tokenomics-fork-prep\nhttps://github.com/Jinn-Network/mono/releases/tag/v0.1.6',
    },
  ],
  pr: [
    {
      payload: {
        title: 'narrow Stage 1 bindResult before reading txHash',
        number: 255,
        author: 'oaksprout',
        base: 'next',
        link: 'https://github.com/Jinn-Network/mono/pull/255',
      },
      output: 'merged #255 by @oaksprout: narrow Stage 1 bindResult before reading txHash\ninto next\nhttps://github.com/Jinn-Network/mono/pull/255',
    },
  ],
  discussion: [
    {
      payload: {
        title: 'Knowledge-market substrate framing',
        category: 'RFCs',
        author: 'oaksprout',
        link: 'https://github.com/Jinn-Network/mono/discussions/59',
      },
      output: 'new RFC discussion: knowledge-market substrate framing\nopened by @oaksprout\nhttps://github.com/Jinn-Network/mono/discussions/59',
    },
  ],
  'solvernet-manifest': [
    {
      payload: {
        name: 'prediction-v0',
        cid: 'bafy...abc',
        chainId: 84532,
        link: 'https://sepolia.basescan.org/tx/0xabc',
      },
      output: 'new solvernet manifest registered on chain 84532: prediction-v0\nmanifest cid: bafy...abc\nhttps://sepolia.basescan.org/tx/0xabc',
    },
  ],
  plugin: [
    {
      payload: {
        name: 'swe-rebench-v2',
        cid: 'bafy...def',
        chainId: 84532,
        link: 'https://sepolia.basescan.org/tx/0xdef',
      },
      output: 'new plugin published on chain 84532: swe-rebench-v2\nmanifest cid: bafy...def\nhttps://sepolia.basescan.org/tx/0xdef',
    },
  ],
};

export function buildUserPrompt(event: BroadcastEvent): string {
  const exemplars = EXEMPLARS[event.type] ?? [];
  const examplesBlock = exemplars
    .map(
      (ex, i) =>
        `Example ${i + 1}\nInput: ${JSON.stringify(ex.payload)}\nOutput:\n${ex.output}`,
    )
    .join('\n\n');
  const eventJson = JSON.stringify({ type: event.type, link: event.link, ...event.payload });
  return [
    examplesBlock,
    '',
    'Now write the tweet for this event:',
    `Input: ${eventJson}`,
    'Output:',
  ]
    .filter(Boolean)
    .join('\n');
}

export function tightenInstruction(reason: string): string {
  return `Your previous output failed validation: ${reason}\nReturn a single tweet that obeys every rule above. No commentary about the fix.`;
}
