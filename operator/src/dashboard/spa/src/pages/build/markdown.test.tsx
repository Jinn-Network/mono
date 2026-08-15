import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { renderMarkdownSubset } from './markdown.js';

describe('renderMarkdownSubset (hfmf)', () => {
  it('renders a paragraph', () => {
    render(<>{renderMarkdownSubset('Hello world.')}</>);
    expect(screen.getByText('Hello world.')).toBeTruthy();
  });

  it('renders an h1', () => {
    render(<>{renderMarkdownSubset('# Build a plug-in')}</>);
    expect(screen.getByRole('heading', { level: 1, name: 'Build a plug-in' })).toBeTruthy();
  });

  it('renders an h2', () => {
    render(<>{renderMarkdownSubset('## Pick a pattern')}</>);
    expect(screen.getByRole('heading', { level: 2, name: 'Pick a pattern' })).toBeTruthy();
  });

  it('renders a fenced code block', () => {
    const md = '```bash\njinn create plugin @you/x\n```';
    render(<>{renderMarkdownSubset(md)}</>);
    const code = screen.getByText(/jinn create plugin @you\/x/);
    expect(code.tagName).toBe('CODE');
    expect(code.parentElement?.tagName).toBe('PRE');
  });

  it('renders inline `code` spans', () => {
    render(<>{renderMarkdownSubset('Use `jinn.plugin.json`.')}</>);
    expect(screen.getByText('jinn.plugin.json').tagName).toBe('CODE');
  });

  it('renders a bullet list', () => {
    render(<>{renderMarkdownSubset('- one\n- two\n- three')}</>);
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
  });

  it('ignores trailing whitespace-only blocks', () => {
    const { container } = render(<>{renderMarkdownSubset('hi\n\n\n')}</>);
    expect(container.textContent?.trim()).toBe('hi');
  });
});
