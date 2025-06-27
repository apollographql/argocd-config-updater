import {
  formatCleanupChanges,
  CleanupChange,
} from '../src/format-cleanup-changes';

describe('formatCleanupChanges', () => {
  it('should return empty string for no changes', () => {
    expect(formatCleanupChanges([])).toBe('');
  });

  it('should format single closed PR', () => {
    const changes: CleanupChange[] = [
      {
        prNumber: 123,
        prTitle: 'Add new feature',
        prURL: 'https://github.com/owner/repo/pull/123',
        appName: 'test-app',
        environment: 'dev',
        closedAt: '2024-01-15T10:30:00Z',
      },
    ];

    const result = formatCleanupChanges(changes);
    expect(result).toContain('Found 1 closed PR:');
    expect(result).toContain('**test-app**');
    expect(result).toContain(
      '- PR [#123](https://github.com/owner/repo/pull/123): Add new feature (closed Jan 15, 2024)',
    );
    expect(result).toMatchSnapshot();
  });

  it('should format multiple closed PRs under single app', () => {
    const changes: CleanupChange[] = [
      {
        prNumber: 123,
        prTitle: 'First PR',
        prURL: 'https://github.com/owner/repo/pull/123',
        appName: 'test-app',
        environment: 'dev',
        closedAt: '2024-01-15T10:30:00Z',
      },
      {
        prNumber: 456,
        prTitle: 'Second PR',
        prURL: 'https://github.com/owner/repo/pull/456',
        appName: 'test-app',
        environment: 'staging',
        closedAt: '2024-01-18T14:20:00Z',
      },
    ];

    const result = formatCleanupChanges(changes);
    expect(result).toContain('Found 2 closed PRs:');
    expect(result).toContain('**test-app** (dev, staging)');
    expect(result).toContain(
      '- PR [#123](https://github.com/owner/repo/pull/123): First PR (closed Jan 15, 2024)',
    );
    expect(result).toContain(
      '- PR [#456](https://github.com/owner/repo/pull/456): Second PR (closed Jan 18, 2024)',
    );
    expect(result).toMatchSnapshot();
  });

  it('should sort PRs by number within app', () => {
    const changes: CleanupChange[] = [
      {
        prNumber: 456,
        prTitle: 'Second PR',
        prURL: 'https://github.com/owner/repo/pull/456',
        appName: 'test-app',
        environment: 'dev',
        closedAt: '2024-01-18T14:20:00Z',
      },
      {
        prNumber: 123,
        prTitle: 'First PR',
        prURL: 'https://github.com/owner/repo/pull/123',
        appName: 'test-app',
        environment: 'dev',
        closedAt: '2024-01-15T10:30:00Z',
      },
    ];

    const result = formatCleanupChanges(changes);
    const lines = result.split('\n');
    const pr123Index = lines.findIndex((line) => line.includes('#123'));
    const pr456Index = lines.findIndex((line) => line.includes('#456'));
    expect(pr123Index).toBeLessThan(pr456Index);
  });

  it('should sort apps alphabetically with blank lines between', () => {
    const changes: CleanupChange[] = [
      {
        prNumber: 123,
        prTitle: 'Router PR',
        prURL: 'https://github.com/owner/repo/pull/123',
        appName: 'test-app',
        environment: 'dev',
        closedAt: '2024-01-15T10:30:00Z',
      },
      {
        prNumber: 456,
        prTitle: 'API PR',
        prURL: 'https://github.com/owner/repo/pull/456',
        appName: 'test-api',
        environment: 'staging',
        closedAt: '2024-01-18T14:20:00Z',
      },
    ];

    const result = formatCleanupChanges(changes);
    expect(result).toMatchSnapshot();

    // Check alphabetical order
    expect(result.indexOf('**test-api**')).toBeLessThan(
      result.indexOf('**test-app**'),
    );
  });

  it('should handle multiple environments for same app', () => {
    const changes: CleanupChange[] = [
      {
        prNumber: 123,
        prTitle: 'Dev PR',
        prURL: 'https://github.com/owner/repo/pull/123',
        appName: 'test-app',
        environment: 'dev',
        closedAt: '2024-01-15T10:30:00Z',
      },
      {
        prNumber: 456,
        prTitle: 'Staging PR',
        prURL: 'https://github.com/owner/repo/pull/456',
        appName: 'test-app',
        environment: 'staging',
        closedAt: '2024-01-18T14:20:00Z',
      },
      {
        prNumber: 789,
        prTitle: 'Another Dev PR',
        prURL: 'https://github.com/owner/repo/pull/789',
        appName: 'test-app',
        environment: 'dev',
        closedAt: '2024-01-20T09:15:00Z',
      },
    ];

    const result = formatCleanupChanges(changes);
    expect(result).toContain('**test-app** (dev, staging)');
    expect(result).toContain('Found 3 closed PRs:');
    expect(result).toMatchSnapshot();
  });
});
