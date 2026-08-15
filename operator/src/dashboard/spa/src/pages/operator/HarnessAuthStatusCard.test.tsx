import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { HarnessAuthStatusCard } from './HarnessAuthStatusCard.js';

const harnessAuthStatus = vi.fn();
vi.mock('../../api/client.js', () => ({
  api: { harnessAuthStatus: () => harnessAuthStatus() },
}));

beforeEach(() => {
  harnessAuthStatus.mockReset();
});

describe('HarnessAuthStatusCard (#564)', () => {
  it('renders one row per harness with name, source path, suffix, mtime and state badge', async () => {
    harnessAuthStatus.mockResolvedValue({
      harnesses: [
        {
          harnessName: 'hermes-agent', sourceKind: 'file', sourcePath: '~/.hermes/.env',
          envKey: 'OPENROUTER_API_KEY', keySuffix: 'a3f9',
          lastModified: '2026-06-14T09:12:00.000Z', state: 'loaded', docAnchor: 'hermes-agent',
        },
        {
          harnessName: 'claude-code', sourceKind: 'session',
          keySuffix: null, lastModified: null, state: 'unknown', docAnchor: 'claude-code',
        },
      ],
    });
    render(<HarnessAuthStatusCard />);
    await waitFor(() => expect(screen.getByText('hermes-agent')).toBeTruthy());
    expect(screen.getByText('~/.hermes/.env')).toBeTruthy();
    expect(screen.getByText(/a3f9/)).toBeTruthy();
    expect(screen.getByText('claude-code')).toBeTruthy();
    // state badges
    expect(screen.getByText(/loaded/i)).toBeTruthy();
    expect(screen.getByText(/unknown/i)).toBeTruthy();
  });

  it('each harness row links to the rotating-harness-keys doc anchor', async () => {
    harnessAuthStatus.mockResolvedValue({
      harnesses: [{
        harnessName: 'hermes-agent', sourceKind: 'file', sourcePath: '~/.hermes/.env',
        envKey: 'OPENROUTER_API_KEY', keySuffix: 'a3f9',
        lastModified: '2026-06-14T09:12:00.000Z', state: 'loaded', docAnchor: 'hermes-agent',
      }],
    });
    render(<HarnessAuthStatusCard />);
    const link = await screen.findByRole('link', { name: /hermes-agent/i });
    expect(link.getAttribute('href')).toContain('rotating-harness-keys');
    expect(link.getAttribute('href')).toContain('#hermes-agent');
  });

  it('renders a friendly empty state when the endpoint returns no harnesses', async () => {
    harnessAuthStatus.mockResolvedValue({ harnesses: [] });
    render(<HarnessAuthStatusCard />);
    await waitFor(() => expect(screen.getByText(/no harnesses/i)).toBeTruthy());
  });

  it('shows missing credentials as a "missing" badge with an em-dash suffix', async () => {
    harnessAuthStatus.mockResolvedValue({
      harnesses: [{
        harnessName: 'hermes-agent', sourceKind: 'file', sourcePath: '~/.hermes/.env',
        envKey: 'OPENROUTER_API_KEY', keySuffix: null, lastModified: null,
        state: 'missing', docAnchor: 'hermes-agent',
      }],
    });
    render(<HarnessAuthStatusCard />);
    await waitFor(() => expect(screen.getByText(/missing/i)).toBeTruthy());
  });

  // AC3 — the panel must surface ONLY the last-4 suffix; the full key bytes must
  // never reach the DOM even if (defensively) a payload were to carry them.
  it('never renders a full key in the DOM — only the last-4 suffix', async () => {
    const fullKey = 'sk-or-v1-deadbeefcafef00dba5eba11c0ffee99a3f9';
    const suffix = fullKey.slice(-4); // 'a3f9'
    harnessAuthStatus.mockResolvedValue({
      harnesses: [{
        harnessName: 'hermes-agent', sourceKind: 'file', sourcePath: '~/.hermes/.env',
        envKey: 'OPENROUTER_API_KEY', keySuffix: suffix,
        lastModified: '2026-06-14T09:12:00.000Z', state: 'loaded', docAnchor: 'hermes-agent',
      }],
    });
    const { container } = render(<HarnessAuthStatusCard />);
    await waitFor(() => expect(screen.getByText('hermes-agent')).toBeTruthy());
    // suffix shows...
    expect(screen.getByText(`…${suffix}`)).toBeTruthy();
    // ...but no prefix of the full key (anything longer than the 4-char suffix) leaks.
    const dom = container.textContent ?? '';
    expect(dom).not.toContain(fullKey);
    expect(dom).not.toContain('deadbeef');
    expect(dom).not.toContain('sk-or-v1');
  });

  // AC3 — the last-modified timestamp renders for a loaded file-kind harness.
  it('renders the last-modified timestamp for a loaded harness', async () => {
    const iso = '2026-06-14T09:12:00.000Z';
    harnessAuthStatus.mockResolvedValue({
      harnesses: [{
        harnessName: 'hermes-agent', sourceKind: 'file', sourcePath: '~/.hermes/.env',
        envKey: 'OPENROUTER_API_KEY', keySuffix: 'a3f9',
        lastModified: iso, state: 'loaded', docAnchor: 'hermes-agent',
      }],
    });
    render(<HarnessAuthStatusCard />);
    await waitFor(() => expect(screen.getByText('hermes-agent')).toBeTruthy());
    // The component formats with toLocaleString(); assert the formatted value is
    // present rather than the raw ISO (which it never renders).
    const formatted = new Date(iso).toLocaleString();
    expect(screen.getByText(formatted)).toBeTruthy();
  });

  // AC2 / AC3 — a `none` / "no auth required" baseline harness renders sanely.
  it('renders a "no auth required" baseline harness with an em-dash suffix and unknown state', async () => {
    harnessAuthStatus.mockResolvedValue({
      harnesses: [{
        harnessName: 'prediction-v1-baseline', sourceKind: 'none',
        keySuffix: null, lastModified: null, state: 'unknown',
      }],
    });
    render(<HarnessAuthStatusCard />);
    await waitFor(() => expect(screen.getByText('prediction-v1-baseline')).toBeTruthy());
    expect(screen.getByText(/no auth required/i)).toBeTruthy();
    // baseline has no docAnchor → name is plain text, not a link.
    expect(screen.queryByRole('link', { name: /prediction-v1-baseline/i })).toBeNull();
  });

  // AC4 — the panel is strictly read-only: no edit/rotate inputs or buttons.
  it('is read-only — exposes no form controls', async () => {
    harnessAuthStatus.mockResolvedValue({
      harnesses: [
        {
          harnessName: 'hermes-agent', sourceKind: 'file', sourcePath: '~/.hermes/.env',
          envKey: 'OPENROUTER_API_KEY', keySuffix: 'a3f9',
          lastModified: '2026-06-14T09:12:00.000Z', state: 'loaded', docAnchor: 'hermes-agent',
        },
        {
          harnessName: 'claude-code', sourceKind: 'session',
          keySuffix: null, lastModified: null, state: 'unknown', docAnchor: 'claude-code',
        },
      ],
    });
    const { container } = render(<HarnessAuthStatusCard />);
    await waitFor(() => expect(screen.getByText('hermes-agent')).toBeTruthy());
    expect(container.querySelectorAll('button').length).toBe(0);
    expect(container.querySelectorAll('input').length).toBe(0);
    expect(container.querySelectorAll('textarea').length).toBe(0);
    expect(container.querySelectorAll('select').length).toBe(0);
    expect(screen.queryByRole('button')).toBeNull();
  });

  // AC6 — a 500 (or any thrown error) renders an inline error, not a crash.
  it('renders an inline error state when the endpoint fails (does not crash)', async () => {
    harnessAuthStatus.mockRejectedValue(new Error('HTTP 500'));
    render(<HarnessAuthStatusCard />);
    await waitFor(() => expect(screen.getByText(/auth status unavailable/i)).toBeTruthy());
    // still renders the card shell, not a blank/crashed page.
    expect(screen.getByTestId('harness-auth-status-card')).toBeTruthy();
    expect(screen.getByText(/HTTP 500/)).toBeTruthy();
  });

  // AC6 — before the first response resolves, a loading affordance shows.
  it('shows a loading state before the first response resolves', () => {
    let resolveFn: (v: unknown) => void = () => {};
    harnessAuthStatus.mockReturnValue(new Promise((r) => { resolveFn = r; }));
    render(<HarnessAuthStatusCard />);
    expect(screen.getByText(/loading/i)).toBeTruthy();
    resolveFn({ harnesses: [] });
  });
});
