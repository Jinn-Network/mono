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
});
