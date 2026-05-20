import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { DebugReportButton } from './DebugReportButton.js';

/**
 * Component tests for the one-click operator debug-report button (issue #420
 * §6). jsdom cannot render `html-to-image`, so the capture module is mocked;
 * the tests assert the manifest dialog, the POST body shape, the download
 * anchor, and graceful degradation when capture throws.
 */

vi.mock('html-to-image', () => ({
  toPng: vi.fn(),
}));

const originalFetch = globalThis.fetch;
const originalCreateObjectURL = globalThis.URL.createObjectURL;
const originalRevokeObjectURL = globalThis.URL.revokeObjectURL;

beforeEach(() => {
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:fake-url');
  globalThis.URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.URL.createObjectURL = originalCreateObjectURL;
  globalThis.URL.revokeObjectURL = originalRevokeObjectURL;
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

const MANIFEST = {
  files: ['status.json', 'config.json', 'redaction-report.md'],
  redaction: { version: 'v1', redacted: ['JINN_PASSWORD'], kept: ['wallet addresses'] },
};

function mockFetch(manifest: unknown = MANIFEST) {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/v1/debug-report/manifest')) {
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => manifest,
      } as Response;
    }
    if (url.includes('/v1/debug-report') && init?.method === 'POST') {
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/gzip' }),
        blob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: 'application/gzip' }),
      } as Response;
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as unknown as typeof fetch;
}

describe('DebugReportButton', () => {
  it('renders the trigger control', () => {
    render(<DebugReportButton />);
    expect(screen.getByRole('button', { name: /debug report/i })).toBeTruthy();
  });

  it('opens a dialog listing the bundle contents from the manifest', async () => {
    mockFetch();
    render(<DebugReportButton />);
    fireEvent.click(screen.getByRole('button', { name: /debug report/i }));
    await waitFor(() => {
      expect(screen.getByText('status.json')).toBeTruthy();
      expect(screen.getByText('config.json')).toBeTruthy();
      expect(screen.getByText('redaction-report.md')).toBeTruthy();
    });
  });

  it('captures a screenshot and POSTs it in the request body on confirm', async () => {
    mockFetch();
    const { toPng } = await import('html-to-image');
    (toPng as ReturnType<typeof vi.fn>).mockResolvedValue(
      'data:image/png;base64,QUJD',
    );
    render(<DebugReportButton />);
    fireEvent.click(screen.getByRole('button', { name: /debug report/i }));
    await waitFor(() => screen.getByText('status.json'));
    fireEvent.click(screen.getByRole('button', { name: /download/i }));

    await waitFor(() => {
      const postCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.find(
        (c) => String(c[0]).includes('/v1/debug-report') &&
          !String(c[0]).includes('manifest') &&
          (c[1] as RequestInit | undefined)?.method === 'POST',
      );
      expect(postCall).toBeDefined();
      const body = JSON.parse((postCall![1] as RequestInit).body as string) as {
        screenshotPngBase64?: string;
      };
      expect(body.screenshotPngBase64).toBe('QUJD');
    });
  });

  it('still POSTs (without screenshot) when capture throws', async () => {
    mockFetch();
    const { toPng } = await import('html-to-image');
    (toPng as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('CSP blocked'));
    render(<DebugReportButton />);
    fireEvent.click(screen.getByRole('button', { name: /debug report/i }));
    await waitFor(() => screen.getByText('status.json'));
    fireEvent.click(screen.getByRole('button', { name: /download/i }));

    await waitFor(() => {
      const postCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.find(
        (c) => String(c[0]).includes('/v1/debug-report') &&
          !String(c[0]).includes('manifest') &&
          (c[1] as RequestInit | undefined)?.method === 'POST',
      );
      expect(postCall).toBeDefined();
      const body = JSON.parse((postCall![1] as RequestInit).body as string) as {
        screenshotPngBase64?: string;
      };
      expect(body.screenshotPngBase64).toBeUndefined();
    });
  });

  it('creates an object URL for the downloaded blob', async () => {
    mockFetch();
    const { toPng } = await import('html-to-image');
    (toPng as ReturnType<typeof vi.fn>).mockResolvedValue('data:image/png;base64,QUJD');
    render(<DebugReportButton />);
    fireEvent.click(screen.getByRole('button', { name: /debug report/i }));
    await waitFor(() => screen.getByText('status.json'));
    fireEvent.click(screen.getByRole('button', { name: /download/i }));
    await waitFor(() => {
      expect(globalThis.URL.createObjectURL).toHaveBeenCalled();
    });
  });
});
