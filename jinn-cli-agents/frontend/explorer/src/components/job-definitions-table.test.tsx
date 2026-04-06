/**
 * JobDefinitionsTable Component Tests
 *
 * These tests ensure the component correctly renders job definitions
 * and only uses fields it needs for display.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { JobDefinitionsTable } from './job-definitions-table';
import type { SubgraphRecord } from '@/hooks/use-subgraph-collection';

// Mock next/link
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}));

function createMockJobDefinition(overrides: Partial<SubgraphRecord> = {}): SubgraphRecord {
  return {
    id: '0064f9f0-cb53-4974-bb27-09699fcf734d',
    name: 'Test Job Definition',
    lastInteraction: 1700000000,
    lastStatus: 'COMPLETED',
    ...overrides,
  } as SubgraphRecord;
}

describe('JobDefinitionsTable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows "No records found" when records array is empty', () => {
    render(<JobDefinitionsTable records={[]} />);
    expect(screen.getByText('No records found')).toBeInTheDocument();
  });

  it('renders table with expected column headers', () => {
    render(<JobDefinitionsTable records={[createMockJobDefinition()]} />);

    expect(screen.getByText('Name')).toBeInTheDocument();
    expect(screen.getByText('Last Activity')).toBeInTheDocument();
    expect(screen.getByText('Status')).toBeInTheDocument();
    expect(screen.getByText('ID')).toBeInTheDocument();
  });

  it('renders job definition data correctly', () => {
    const records = [
      createMockJobDefinition({
        name: 'My Test Job Definition',
        lastStatus: 'FAILED',
      }),
    ];

    render(<JobDefinitionsTable records={records} />);

    expect(screen.getByText('My Test Job Definition')).toBeInTheDocument();
    expect(screen.getByText('FAILED')).toBeInTheDocument();
  });

  it('renders link to job definition detail page', () => {
    render(<JobDefinitionsTable records={[createMockJobDefinition({ id: 'job-def-123' })]} />);

    const link = screen.getByRole('link', { name: /Test Job Definition/i });
    expect(link).toHaveAttribute('href', '/jobDefinitions/job-def-123');
  });

  it('displays dash when lastInteraction is missing', () => {
    render(<JobDefinitionsTable records={[createMockJobDefinition({ lastInteraction: null })]} />);

    const table = screen.getByRole('table');
    const rows = table.querySelectorAll('tbody tr');
    expect(rows[0].querySelectorAll('td')[1].textContent).toBe('-');
  });

  it('displays UNKNOWN when lastStatus is missing', () => {
    render(<JobDefinitionsTable records={[createMockJobDefinition({ lastStatus: null })]} />);
    expect(screen.getByText('UNKNOWN')).toBeInTheDocument();
  });

  it('truncates long job names', () => {
    const longName = 'a'.repeat(70);
    render(<JobDefinitionsTable records={[createMockJobDefinition({ name: longName })]} />);

    const truncated = longName.substring(0, 60) + '...';
    expect(screen.getByText(truncated)).toBeInTheDocument();
  });

  it('displays full job name when under 60 chars', () => {
    const shortName = 'Short Job Name';
    render(<JobDefinitionsTable records={[createMockJobDefinition({ name: shortName })]} />);

    expect(screen.getByText(shortName)).toBeInTheDocument();
  });

  it('renders multiple job definitions correctly', () => {
    const records = [
      createMockJobDefinition({ id: 'job-1', name: 'Job One' }),
      createMockJobDefinition({ id: 'job-2', name: 'Job Two' }),
      createMockJobDefinition({ id: 'job-3', name: 'Job Three' }),
    ];

    render(<JobDefinitionsTable records={records} />);

    expect(screen.getByText('Job One')).toBeInTheDocument();
    expect(screen.getByText('Job Two')).toBeInTheDocument();
    expect(screen.getByText('Job Three')).toBeInTheDocument();
  });
});

