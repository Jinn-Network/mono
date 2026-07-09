/**
 * Plain-text renderers for the `distil` consent + run surface (issue #1490).
 *
 * The 1490 mockup is a colour, keyboard-driven console; this package has no ANSI
 * layer and its CLI prints plain text (see `renderScrubReport`, `renderRecord`).
 * So these are pure string renderers that carry the design's *copy* and *states*
 * faithfully — the load-bearing part — in plain text, with box-drawing panels
 * (allowed) standing in for the coloured boxes. Status is a WORD, never a glyph
 * (the brand's ban on `✓/✗` as UI icons), and every string that touches cost or
 * consent drops all vow-metaphor and says exactly what happens.
 *
 * Binary name is `jinn-layer` (the real shipped bin, #1489). The mockup writes
 * `jinn-agent`; that is a pending branding decision, reconciled later.
 */

const BIN = 'jinn-layer';

import type { DistilMode } from './distil-mode.js';

function plural(n: number, one: string): string {
  return `${n} ${one}${n === 1 ? '' : 's'}`;
}

// ── boxed panel (plain analogue of the mockup's coloured box) ────────────────
// The three border rows and every body row share one frame width (IW + 4), so
// the panel never overflows its widest line.

function boxTop(iw: number, title: string): string {
  const t = ` ${title} `;
  return `┌─${t}${'─'.repeat(Math.max(0, iw + 1 - t.length))}┐`;
}
function boxBot(iw: number): string {
  return `└${'─'.repeat(iw + 2)}┘`;
}
function boxLine(iw: number, content: string): string {
  const clipped = content.length > iw ? content.slice(0, iw) : content;
  return `│ ${clipped}${' '.repeat(Math.max(0, iw - clipped.length))} │`;
}

function box(title: string, contentLines: string[]): string {
  const iw = Math.max(title.length + 1, ...contentLines.map((l) => l.length), 40);
  return [boxTop(iw, title), ...contentLines.map((l) => boxLine(iw, l)), boxBot(iw)].join('\n');
}

/** One skill in a run panel: its name, install state, forward value, and sources. */
export interface RenderedSkill {
  name: string;
  installed: boolean;
  /** Human-readable source-capture labels (task summaries, or the raw ref). */
  provenance: string[];
  /**
   * Forward-looking value: what this skill will help with next time (the
   * distiller's when-to-use description). Rendered as the `helps` line so the
   * operator sees what they are getting, not just where it came from.
   */
  helpsWith?: string;
}

/** Width of the install-state column (mockup uses 14). */
const STATE_COL = 14;

/**
 * 1a — first-run consent disclosure. Leads with what distillation is FOR, then
 * states plainly what it READS, what it COSTS (compute, not money), and what
 * LEAVES the machine (nothing, with the one hosted-distiller exception named).
 */
export function renderConsentDisclosure(o: { captureCount: number; distillModel: string }): string {
  return [
    `  Distil your recent tasks into skills?`,
    '',
    `  A frontier-class model reads the tasks you've run here, once, and pulls`,
    `  out reusable skills — later tasks then reuse them on a small, cheap model.`,
    `  Pay the heavy pass once; reuse the skills for free.`,
    '',
    `  READS    ${plural(o.captureCount, 'capture')} this run — the tasks you've run here so far, more`,
    `           as you work. Nothing else.`,
    '',
    `  COSTS    one pass of heavy compute — not money — and it runs here, on`,
    `           this machine.`,
    '',
    `  LEAVES   nothing — read, distilled, and written here; nothing is published`,
    `           to the Jinn network. A hosted distiller (below) is the one`,
    `           exception; ${BIN} names it and asks first.`,
    '',
    `  DISTILLER  ${o.distillModel} (local) — the model that writes the skills, and`,
    `             yours to choose. Change with --distiller <provider> or`,
    `             --distiller-model <model>.`,
    '',
    `  [L] Local now   ·   [F] Defer (default)   ·   [O] Off   ·   [P] Preview`,
    '',
    `  distil: unset — default is defer, nothing runs, nothing is spent`,
  ].join('\n');
}

/** 1a — the preview screen: exactly what a run would read and the distiller. */
export function renderPreview(o: {
  captures: { summary: string; when: string; size: string }[];
  distillModel: string;
}): string {
  const rows = o.captures.map((c) => boxLine(54, `${c.when.padEnd(9)}${c.summary}`));
  const iw = 54;
  const panel = [
    boxTop(iw, 'captures · read locally, never sent'),
    ...rows,
    boxBot(iw),
  ].join('\n');
  return [
    `  PREVIEW — NOTHING RUNS FROM THIS SCREEN`,
    `  The exact captures a run would read, and the distiller it would use.`,
    '',
    panel,
    '',
    `  distiller  ${o.distillModel} (local, default) · change with --distiller`,
    `  With the local default, none of this leaves the machine.`,
    '',
    `  [L] Run local now   ·   [B] Back`,
  ].join('\n');
}

/** 1a — confirm the one spend before a local run. */
export function renderConfirmLocal(o: { captureCount: number; distillModel: string }): string {
  return [
    `  CONFIRM`,
    '',
    `  Run distillation now? One frontier pass with ${o.distillModel} over`,
    `  ${plural(o.captureCount, 'capture')}, here on this machine — heavy compute, no money, nothing`,
    `  sent. Stop any time; whatever finished is kept.`,
    '',
    `  [Y] Yes, run now   ·   [N] No, go back`,
  ].join('\n');
}

/** 1c — one-line echo after `distil --where <mode>` sets the persistent mode. */
export function renderModeSet(mode: DistilMode): string {
  switch (mode) {
    case 'local':
      return `distil: mode set to local. Runs here with a frontier-class model.`;
    case 'defer':
      return `distil: mode set to deferred. Captures held locally; nothing runs or publishes.`;
    case 'off':
      return `distil: mode set to off. Captures are not reserved for distillation.`;
  }
}

/** 1c — what a bare `distil` prints while the mode is defer: it runs nothing. */
export function renderDeferredRun(o: { captureCount: number; capturesDir: string }): string {
  return [
    `  distil: deferred — ${plural(o.captureCount, 'capture')} held locally, nothing runs.`,
    '',
    `  They stay on this machine and are not published. When the bonded network`,
    `  can distil a contributed signal, you'll be asked before anything leaves`,
    `  this machine. (not available yet — rung 3)`,
    '',
    `  Run locally now  ·  ${BIN} distil --where local`,
  ].join('\n');
}

/** 1a — the recorded-state confirmation after a mode is chosen. */
export function renderRecorded(mode: DistilMode, o: { captureCount: number }): string {
  switch (mode) {
    case 'local':
      return [
        `  recorded — distil mode is LOCAL`,
        '',
        `  Distillation runs on this machine with a frontier-class model.`,
        '',
        `  Change any time  ·  ${BIN} distil --where defer  |  --where off`,
      ].join('\n');
    case 'defer':
      return [
        `  recorded — distil mode is DEFERRED`,
        '',
        `  Your ${plural(o.captureCount, 'capture')} are held on this machine. Nothing runs, nothing is`,
        `  spent, and nothing is published to the Jinn network.`,
        '',
        `  Run locally instead  ·  ${BIN} distil --where local`,
      ].join('\n');
    case 'off':
      return [
        `  recorded — distil is OFF`,
        '',
        `  Distillation is disabled and no captures are reserved for it. Nothing`,
        `  the harness already keeps is deleted — this only turns distilling off.`,
        '',
        `  Turn it on any time  ·  ${BIN} distil --where local  |  --where defer`,
      ].join('\n');
  }
}

/** 1d — nothing to distil yet: say what produces a capture. */
export function renderEmpty(o: { capturesDir: string }): string {
  return [
    `  No eligible captures.`,
    '',
    `  Distillation reads captures — the tasks you've run with the harness.`,
    `  There aren't any yet — run a task first, then run \`${BIN} distil\` again.`,
    '',
    `  (looked in ${o.capturesDir})`,
  ].join('\n');
}

/**
 * 1b — the skills panel: per-skill install-state word + name, then the
 * forward-looking `helps` line (what it will help with next) and the backward
 * `from` line (which captures it came from).
 */
export function renderSkillsPanel(skills: RenderedSkill[], title: string): string {
  const content: string[] = [];
  skills.forEach((s, i) => {
    const state = (s.installed ? 'installed' : 'not installed').padEnd(STATE_COL);
    content.push(`${state}${s.name}`);
    if (s.helpsWith) content.push(`${' '.repeat(STATE_COL)}helps  ${s.helpsWith}`);
    content.push(`${' '.repeat(STATE_COL)}from   ${s.provenance.join(' · ')}`);
    if (i < skills.length - 1) content.push('');
  });
  return box(title, content);
}

/** Title + footer for the run terminus, keyed to how many skills are installed. */
function runSummaryChrome(installed: number, total: number): { title: string; footer: string[] } {
  if (installed === 0) {
    return {
      title: 'skills · distilled locally · not installed',
      footer: [
        `  They stay local until you install them — nothing goes live until you choose.`,
        `  Install  ·  ${BIN} distil --install all   ·   --install <name>   ·   --install none`,
        `  List them  ·  /jinn skills`,
      ],
    };
  }
  if (installed === total) {
    return {
      title: 'skills · installed · ready',
      footer: [
        `  Next runs use these on a small model — no frontier pass.`,
        `  Manage  ·  /jinn skills   ·   /jinn skills remove <name>`,
      ],
    };
  }
  return {
    title: `skills · ${installed} installed · ${total - installed} available`,
    footer: [
      `  Installed skills run on a small model next time — no frontier pass.`,
      `  Install the rest  ·  ${BIN} distil --install all`,
      `  Manage  ·  /jinn skills`,
    ],
  };
}

/**
 * 1b — the run terminus. Header, captures→skills summary, the skills panel with
 * per-skill install state, and a footer keyed to the install outcome (none
 * installed = staged/how-to-install, all = ready, some = partial).
 */
export function renderRunSummary(o: {
  distillModel: string;
  captureCount: number;
  skills: RenderedSkill[];
}): string {
  const installed = o.skills.filter((s) => s.installed).length;
  const { title, footer } = runSummaryChrome(installed, o.skills.length);
  return [
    `  distil: local · distiller ${o.distillModel} · ${plural(o.captureCount, 'capture')}`,
    '',
    `  distilled · ${plural(o.captureCount, 'capture')} → ${plural(o.skills.length, 'skill')} · nothing left this machine`,
    '',
    renderSkillsPanel(o.skills, title),
    '',
    ...footer,
  ].join('\n');
}

/**
 * 1b — the review shown before the install choice (interactive). Frames the
 * skills FORWARD — what they'll help with next — then asks for an explicit
 * all / one / skip choice. Nothing is installed until the operator answers.
 */
export function renderReview(o: {
  distillModel: string;
  captureCount: number;
  skills: RenderedSkill[];
}): string {
  return [
    `  distil: local · distiller ${o.distillModel} · ${plural(o.captureCount, 'capture')}`,
    '',
    `  distilled ${plural(o.skills.length, 'skill')} — they'll help with tasks like these next time:`,
    '',
    renderSkillsPanel(o.skills.map((s) => ({ ...s, installed: false })), 'skills · distilled locally · not installed'),
    '',
    `  Install all, one, or skip? Nothing goes live until you choose.`,
  ].join('\n');
}

/** 1d — a run failed mid-way: what stopped, what survived, one resume command. */
export function renderFailure(o: {
  distillModel: string;
  distilledCount: number;
  errors: { clusterId: string; error: string }[];
}): string {
  const first = o.errors[0]?.error ?? 'the distiller stopped responding';
  return [
    `  distil failed — ${first}`,
    '',
    `  ${plural(o.distilledCount, 'skill')} were distilled and kept. ${plural(o.errors.length, 'cluster')} did not`,
    `  finish; the rest weren't distilled. Nothing was sent or lost.`,
    '',
    `  Resume the rest  ·  ${BIN} distil --resume`,
    `  See what's done  ·  /jinn skills`,
  ].join('\n');
}

/** 1c/1d — `--resume` with no capture left to distil. */
export function renderResumeNothing(o: { captureCount: number }): string {
  return `Nothing to resume — all ${plural(o.captureCount, 'capture')} are already distilled.`;
}
