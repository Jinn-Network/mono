/**
 * Tiny markdown-to-JSX renderer for the /build route's intro card.
 *
 * Handles only the subset used in /docs/build/*.md:
 *   - # / ## / ### headings
 *   - paragraphs
 *   - fenced code blocks (``` lang \n ... \n ```)
 *   - inline `code`
 *   - - bullet lists
 *
 * No HTML, no images, no tables. We pick the subset over react-markdown
 * because the dashboard SPA bundle stays dependency-light and the markdown
 * we render is curated, not user-generated.
 */
import type { ReactNode } from 'react';
import { createElement, Fragment } from 'react';

interface Block {
  kind: 'heading' | 'paragraph' | 'code' | 'list';
  level?: 1 | 2 | 3;
  text?: string;
  lang?: string;
  items?: string[];
}

function tokenize(md: string): Block[] {
  const blocks: Block[] = [];
  const lines = md.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (/^```/.test(line)) {
      const lang = line.slice(3).trim();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i] ?? '')) {
        buf.push(lines[i] ?? '');
        i++;
      }
      i++;
      blocks.push({ kind: 'code', lang, text: buf.join('\n') });
      continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      blocks.push({ kind: 'heading', level: h[1].length as 1 | 2 | 3, text: h[2] });
      i++;
      continue;
    }
    if (/^-\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^-\s+/.test(lines[i] ?? '')) {
        items.push((lines[i] ?? '').replace(/^-\s+/, ''));
        i++;
      }
      blocks.push({ kind: 'list', items });
      continue;
    }
    if (line.trim() === '') {
      i++;
      continue;
    }
    const buf = [line];
    i++;
    while (i < lines.length && (lines[i] ?? '').trim() !== '' && !/^(#{1,3}\s|```|-\s)/.test(lines[i] ?? '')) {
      buf.push(lines[i] ?? '');
      i++;
    }
    blocks.push({ kind: 'paragraph', text: buf.join(' ') });
  }
  return blocks;
}

function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /`([^`]+)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(createElement('code', { key: `c-${k++}` }, m[1]));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function renderMarkdownSubset(md: string): ReactNode {
  const blocks = tokenize(md);
  return createElement(
    Fragment,
    null,
    ...blocks.map((b, idx) => {
      if (b.kind === 'heading') {
        if (b.level === 1) return createElement('h1', { key: idx }, b.text);
        if (b.level === 2) return createElement('h2', { key: idx }, b.text);
        return createElement('h3', { key: idx }, b.text);
      }
      if (b.kind === 'code') {
        return createElement('pre', { key: idx }, createElement('code', null, b.text ?? ''));
      }
      if (b.kind === 'list') {
        return createElement(
          'ul',
          { key: idx },
          ...(b.items ?? []).map((it, j) => createElement('li', { key: j }, ...renderInline(it))),
        );
      }
      return createElement('p', { key: idx }, ...renderInline(b.text ?? ''));
    }),
  );
}
