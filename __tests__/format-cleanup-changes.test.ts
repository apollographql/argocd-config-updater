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
        appName: 'test-app',
        teamName: 'test-team',
        environment: 'dev',
        closedAt: '2024-01-15T10:30:00Z',
      },
    ];

    const result = formatCleanupChanges(changes);
    expect(result).toContain('Found 1 closed PR:');
    expect(result).toContain('**test-team/test-app** (dev)');
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
        appName: 'test-app',
        teamName: 'test-team',
        environment: 'dev',
        closedAt: '2024-01-15T10:30:00Z',
      },
      {
        prNumber: 456,
        prTitle: 'Second PR',
        prURL: 'https://github.com/owner/repo/pull/456',
        appName: 'test-app',
        teamName: 'test-team',
        environment: 'dev',
        closedAt: '2024-01-18T14:20:00Z',
      },
    ];

    const result = formatCleanupChanges(changes);
    expect(result).toContain('Found 2 closed PRs:');
    expect(result).toContain('**test-team/test-app** (dev)');
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
        appName: 'test-app',
        teamName: 'test-team',
        environment: 'dev',
        closedAt: '2024-01-15T10:30:00Z',
      },
      {
        prNumber: 456,
        prTitle: 'Staging PR',
        prURL: 'https://github.com/owner/repo/pull/456',
        appName: 'test-app',
        teamName: 'test-team',
        environment: 'staging',
        closedAt: '2024-01-18T14:20:00Z',
      },
      {
        prNumber: 789,
        prTitle: 'Dev PR 2',
        prURL: 'https://github.com/owner/repo/pull/789',
        appName: 'test-app',
        teamName: 'test-team',
        environment: 'dev',
        closedAt: '2024-01-20T09:15:00Z',
      },
    ];

    const result = formatCleanupChanges(changes);
    expect(result).toContain('Found 3 closed PRs:');

    // Verify dev PRs are grouped together
    const lines = result.split('\n');
    const devSectionIndex = lines.findIndex((line) =>
      line.includes('**test-team/test-app** (dev)'),
    );
    expect(lines[devSectionIndex + 1]).toContain('#123');
    expect(lines[devSectionIndex + 2]).toContain('#789');

    // Verify staging is separate
    const stagingSectionIndex = lines.findIndex((line) =>
      line.includes('**test-team/test-app** (staging)'),
    );
    expect(lines[stagingSectionIndex + 1]).toContain('#456');

    expect(result).toMatchSnapshot();
  });
});
