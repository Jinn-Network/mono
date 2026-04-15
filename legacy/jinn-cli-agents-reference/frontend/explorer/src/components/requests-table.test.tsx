/**
 * Frontend tests for requests-table.tsx
 * Phase 2 verification: Frontend dependency display
 * 
 * Tests the DependencyCell component and requests table rendering with dependencies.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { RequestsTable } from './requests-table';
import { getDependencyInfo } from '@/lib/subgraph';
import type { SubgraphRecord } from '@/hooks/use-subgraph-collection';

// Mock the subgraph module
vi.mock('@/lib/subgraph', () => ({
  getDependencyInfo: vi.fn(),
}));

// Mock next/link
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}));

// Mock utils
vi.mock('@/lib/utils', () => ({
  formatDate: (timestamp: number) => new Date(timestamp * 1000).toLocaleString(),
}));

describe('RequestsTable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('DependencyCell component', () => {
    it('renders nothing when request has no dependencies', () => {
      const records: SubgraphRecord[] = [
        {
          id: '0xRequest1',
          type: 'request',
          jobName: 'Test Job',
          jobDefinitionId: 'job-def-1',
          requestId: '0xRequest1',
          sender: '0xSender1',
          mech: '0xMech1',
          delivered: false,
          blockTimestamp: 1000000,
          dependencies: [],
        },
      ];

      render(<RequestsTable records={records} />);

      // Should show dash for no dependencies
      const dependencyCell = screen.getByText('-');
      expect(dependencyCell).toBeInTheDocument();
    });

    it('renders badge with count when dependencies are present', () => {
      const records: SubgraphRecord[] = [
        {
          id: '0xRequest2',
          type: 'request',
          jobName: 'Test Job with Deps',
          jobDefinitionId: 'job-def-2',
          requestId: '0xRequest2',
          sender: '0xSender2',
          mech: '0xMech2',
          delivered: false,
          blockTimestamp: 1000000,
          dependencies: ['dep-1', 'dep-2', 'dep-3'],
        },
      ];

      render(<RequestsTable records={records} />);

      // Should show count badge
      const countBadge = screen.getByText('3');
      expect(countBadge).toBeInTheDocument();
      expect(countBadge).toHaveClass('font-medium');
    });

    it('displays tooltip with dependency details on hover', async () => {
      const mockDependencyInfo = [
        {
          id: 'dep-1',
          jobName: 'Dependency Job 1',
          delivered: true,
          status: 'completed',
        },
        {
          id: 'dep-2',
          jobName: 'Dependency Job 2',
          delivered: false,
          status: 'in_progress',
        },
        {
          id: 'dep-3',
          jobName: 'Dependency Job 3',
          delivered: false,
          status: 'pending',
        },
      ];

      (getDependencyInfo as ReturnType<typeof vi.fn>).mockResolvedValue(mockDependencyInfo);

      const records: SubgraphRecord[] = [
        {
          id: '0xRequest3',
          type: 'request',
          jobName: 'Test Job',
          jobDefinitionId: 'job-def-3',
          requestId: '0xRequest3',
          sender: '0xSender3',
          mech: '0xMech3',
          delivered: false,
          blockTimestamp: 1000000,
          dependencies: ['dep-1', 'dep-2', 'dep-3'],
        },
      ];

      render(<RequestsTable records={records} />);

      const countBadge = screen.getByText('3');
      
      // Hover over the badge
      fireEvent.mouseEnter(countBadge);

      // Wait for tooltip to appear
      await waitFor(() => {
        expect(screen.getByText('Depends on:')).toBeInTheDocument();
      });

      // Check dependency details are displayed
      expect(screen.getByText('Dependency Job 1')).toBeInTheDocument();
      expect(screen.getByText('Dependency Job 2')).toBeInTheDocument();
      expect(screen.getByText('Dependency Job 3')).toBeInTheDocument();

      // Verify getDependencyInfo was called
      expect(getDependencyInfo).toHaveBeenCalledWith(['dep-1', 'dep-2', 'dep-3']);
    });

    it('shows correct status icons for different dependency states', async () => {
      const mockDependencyInfo = [
        {
          id: 'dep-1',
          jobName: 'Completed Job',
          delivered: true,
          status: 'completed',
        },
        {
          id: 'dep-2',
          jobName: 'In Progress Job',
          delivered: false,
          status: 'in_progress',
        },
        {
          id: 'dep-3',
          jobName: 'Pending Job',
          delivered: false,
          status: 'pending',
        },
      ];

      (getDependencyInfo as ReturnType<typeof vi.fn>).mockResolvedValue(mockDependencyInfo);

      const records: SubgraphRecord[] = [
        {
          id: '0xRequest4',
          type: 'request',
          jobName: 'Test Job',
          jobDefinitionId: 'job-def-4',
          requestId: '0xRequest4',
          sender: '0xSender4',
          mech: '0xMech4',
          delivered: false,
          blockTimestamp: 1000000,
          dependencies: ['dep-1', 'dep-2', 'dep-3'],
        },
      ];

      render(<RequestsTable records={records} />);

      const countBadge = screen.getByText('3');
      fireEvent.mouseEnter(countBadge);

      await waitFor(() => {
        expect(screen.getByText('Depends on:')).toBeInTheDocument();
      });

      // Check for status icons
      // ✓ for completed
      expect(screen.getByText('✓')).toBeInTheDocument();
      // ⏳ for in progress
      expect(screen.getByText('⏳')).toBeInTheDocument();
      // ○ for pending
      expect(screen.getByText('○')).toBeInTheDocument();
    });

    it('shows loading state while fetching dependency info', async () => {
      // Mock a delayed response
      (getDependencyInfo as ReturnType<typeof vi.fn>).mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve([]), 100))
      );

      const records: SubgraphRecord[] = [
        {
          id: '0xRequest5',
          type: 'request',
          jobName: 'Test Job',
          jobDefinitionId: 'job-def-5',
          requestId: '0xRequest5',
          sender: '0xSender5',
          mech: '0xMech5',
          delivered: false,
          blockTimestamp: 1000000,
          dependencies: ['dep-1'],
        },
      ];

      render(<RequestsTable records={records} />);

      const countBadge = screen.getByText('1');
      fireEvent.mouseEnter(countBadge);

      // Should show loading state
      await waitFor(() => {
        expect(screen.getByText('Loading...')).toBeInTheDocument();
      });
    });

    it('shows "more" indicator when dependencies exceed 5', async () => {
      const mockDependencyInfo = Array.from({ length: 7 }, (_, i) => ({
        id: `dep-${i + 1}`,
        jobName: `Dependency Job ${i + 1}`,
        delivered: i < 3,
        status: i < 3 ? 'completed' : 'pending',
      }));

      (getDependencyInfo as ReturnType<typeof vi.fn>).mockResolvedValue(mockDependencyInfo);

      const records: SubgraphRecord[] = [
        {
          id: '0xRequest6',
          type: 'request',
          jobName: 'Test Job',
          jobDefinitionId: 'job-def-6',
          requestId: '0xRequest6',
          sender: '0xSender6',
          mech: '0xMech6',
          delivered: false,
          blockTimestamp: 1000000,
          dependencies: Array.from({ length: 7 }, (_, i) => `dep-${i + 1}`),
        },
      ];

      render(<RequestsTable records={records} />);

      const countBadge = screen.getByText('7');
      fireEvent.mouseEnter(countBadge);

      await waitFor(() => {
        expect(screen.getByText('Depends on:')).toBeInTheDocument();
      });

      // Should only show first 5
      expect(screen.getByText('Dependency Job 1')).toBeInTheDocument();
      expect(screen.getByText('Dependency Job 5')).toBeInTheDocument();
      
      // Should show "+2 more..."
      expect(screen.getByText('+2 more...')).toBeInTheDocument();
    });

    it('hides tooltip when mouse leaves', async () => {
      const mockDependencyInfo = [
        {
          id: 'dep-1',
          jobName: 'Dependency Job 1',
          delivered: true,
          status: 'completed',
        },
      ];

      (getDependencyInfo as ReturnType<typeof vi.fn>).mockResolvedValue(mockDependencyInfo);

      const records: SubgraphRecord[] = [
        {
          id: '0xRequest7',
          type: 'request',
          jobName: 'Test Job',
          jobDefinitionId: 'job-def-7',
          requestId: '0xRequest7',
          sender: '0xSender7',
          mech: '0xMech7',
          delivered: false,
          blockTimestamp: 1000000,
          dependencies: ['dep-1'],
        },
      ];

      render(<RequestsTable records={records} />);

      const countBadge = screen.getByText('1');
      
      // Show tooltip
      fireEvent.mouseEnter(countBadge);
      await waitFor(() => {
        expect(screen.getByText('Depends on:')).toBeInTheDocument();
      });

      // Hide tooltip
      fireEvent.mouseLeave(countBadge);
      await waitFor(() => {
        expect(screen.queryByText('Depends on:')).not.toBeInTheDocument();
      });
    });

    it('handles API errors gracefully', async () => {
      (getDependencyInfo as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('API error'));
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const records: SubgraphRecord[] = [
        {
          id: '0xRequest8',
          type: 'request',
          jobName: 'Test Job',
          jobDefinitionId: 'job-def-8',
          requestId: '0xRequest8',
          sender: '0xSender8',
          mech: '0xMech8',
          delivered: false,
          blockTimestamp: 1000000,
          dependencies: ['dep-1'],
        },
      ];

      render(<RequestsTable records={records} />);

      const countBadge = screen.getByText('1');
      fireEvent.mouseEnter(countBadge);

      // Should not crash, error should be logged
      await waitFor(() => {
        expect(consoleErrorSpy).toHaveBeenCalled();
      });

      consoleErrorSpy.mockRestore();
    });
  });

  describe('RequestsTable rendering', () => {
    it('shows "No records found" when records array is empty', () => {
      render(<RequestsTable records={[]} />);
      expect(screen.getByText('No records found')).toBeInTheDocument();
    });

    it('renders table with all column headers', () => {
      const records: SubgraphRecord[] = [
        {
          id: '0xRequest1',
          type: 'request',
          jobName: 'Test Job',
          jobDefinitionId: 'job-def-1',
          requestId: '0xRequest1',
          sender: '0xSender1',
          mech: '0xMech1',
          delivered: false,
          blockTimestamp: 1000000,
          dependencies: [],
        },
      ];

      render(<RequestsTable records={records} />);

      expect(screen.getByText('Job Name')).toBeInTheDocument();
      expect(screen.getByText('Job Def ID')).toBeInTheDocument();
      expect(screen.getByText('Request ID')).toBeInTheDocument();
      expect(screen.getByText('Status')).toBeInTheDocument();
      expect(screen.getByText('Dependencies')).toBeInTheDocument();
    });

    it('renders request data correctly', () => {
      const records: SubgraphRecord[] = [
        {
          id: '0xRequest1',
          type: 'request',
          jobName: 'My Test Job',
          jobDefinitionId: 'job-def-1',
          requestId: '0xRequest1',
          sender: '0xSender1',
          mech: '0xMech1',
          delivered: true,
          blockTimestamp: 1000000,
          dependencies: [],
        },
      ];

      render(<RequestsTable records={records} />);

      expect(screen.getByText('My Test Job')).toBeInTheDocument();
      expect(screen.getByText('job-def-1')).toBeInTheDocument();
    });
  });
});

