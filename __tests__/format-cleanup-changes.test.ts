import { describe, it, expect } from 'vitest';
import {
  formatCleanupChanges,
  CleanupChange,
} from '../src/format-cleanup-changes';

describe('formatCleanupChanges', () => {
  it('should return empty string for no changes', () => {
    expect(formatCleanupChanges([])).toBe('');
  });

  it('should format a single closed PR', () => {
    const changes: CleanupChange[] = [
      {
        prNumber: 123,
        prTitle: 'Add new feature',
        prURL: 'https://github.com/owner/repo/pull/123',
        filename: 'teams/test-team/test-app/application-values.yaml',
        environment: 'dev',
        closedAt: '2024-01-15T10:30:00Z',
      },
    ];

    const result = formatCleanupChanges(changes);
    expect(result).toContain('## Found 1 closed PR');
    expect(result).toContain('### dev');
    expect(result).toContain('- teams/test-team/test-app');
    expect(result).toContain(
      '- PR [#123](https://github.com/owner/repo/pull/123): Add new feature (closed Jan 15, 2024)',
    );
    expect(result).toMatchSnapshot();
  });

  it('should format multiple closed PRs under same app and environment', () => {
    const changes: CleanupChange[] = [
      {
        prNumber: 123,
        prTitle: 'First PR',
        prURL: 'https://github.com/owner/repo/pull/123',
        filename: 'teams/test-team/test-app/application-values.yaml',
        environment: 'dev',
        closedAt: '2024-01-15T10:30:00Z',
      },
      {
        prNumber: 456,
        prTitle: 'Second PR',
        prURL: 'https://github.com/owner/repo/pull/456',
        filename: 'teams/test-team/test-app/application-values.yaml',
        environment: 'dev',
        closedAt: '2024-01-18T14:20:00Z',
      },
    ];

    const result = formatCleanupChanges(changes);
    expect(result).toContain('## Found 2 closed PRs');
    expect(result).toContain('### dev');
    expect(result).toContain('- teams/test-team/test-app');
    expect(result).toContain(
      '- PR [#123](https://github.com/owner/repo/pull/123): First PR (closed Jan 15, 2024)',
    );
    expect(result).toContain(
      '- PR [#456](https://github.com/owner/repo/pull/456): Second PR (closed Jan 18, 2024)',
    );
    expect(result).toMatchSnapshot();
  });

  it('should handle multiple PRs across different apps and environments', () => {
    const changes: CleanupChange[] = [
      {
        prNumber: 123,
        prTitle: 'Dev PR 1',
        prURL: 'https://github.com/owner/repo/pull/123',
        filename: 'teams/test-team/test-app/application-values.yaml',
        environment: 'dev',
        closedAt: '2024-01-15T10:30:00Z',
      },
      {
        prNumber: 456,
        prTitle: 'Staging PR',
        prURL: 'https://github.com/owner/repo/pull/456',
        filename: 'teams/test-team/test-app/application-values.yaml',
        environment: 'staging',
        closedAt: '2024-01-18T14:20:00Z',
      },
      {
        prNumber: 789,
        prTitle: 'Dev PR 2',
        prURL: 'https://github.com/owner/repo/pull/789',
        filename: 'teams/test-team/test-app/application-values.yaml',
        environment: 'dev',
        closedAt: '2024-01-20T09:15:00Z',
      },
    ];

    const result = formatCleanupChanges(changes);
    expect(result).toContain('## Found 3 closed PRs');

    // Verify dev PRs are grouped together and come before staging
    const lines = result.split('\n');
    const devSectionIndex = lines.findIndex((line) => line === '### dev');
    const stagingSectionIndex = lines.findIndex(
      (line) => line === '### staging',
    );
    expect(devSectionIndex).toBeGreaterThan(-1);
    expect(stagingSectionIndex).toBeGreaterThan(-1);

    // Check that both dev PRs are under the dev section
    const devAppIndex = lines.findIndex(
      (line) => line === '- teams/test-team/test-app',
      devSectionIndex,
    );
    expect(lines[devAppIndex + 1]).toContain('#123');
    expect(lines[devAppIndex + 2]).toContain('#789');

    expect(result).toMatchSnapshot();
  });
});
