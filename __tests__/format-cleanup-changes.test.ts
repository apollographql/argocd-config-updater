import {
  formatCleanupChanges,
  CleanupChange,
} from '../src/format-cleanup-changes';

describe('formatCleanupChanges', () => {
  it('should return empty string for no changes', () => {
    const result = formatCleanupChanges([]);
    expect(result).toBe('');
  });

  it('should find single closed PRs', () => {
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
  });

  it('should find multiple closed PRs', () => {
    const changes: CleanupChange[] = [
      {
        prNumber: 456,
        prTitle: 'Second PR',
        prURL: 'https://github.com/owner/repo/pull/456',
        appName: 'test-app',
        environment: 'staging',
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
    expect(result).toContain('Found 2 closed PRs:');
    expect(result).toContain('**test-app** (dev, staging)');
    expect(result).toContain(
      '- PR [#123](https://github.com/owner/repo/pull/123): First PR (closed Jan 15, 2024)',
    );
    expect(result).toContain(
      '- PR [#456](https://github.com/owner/repo/pull/456): Second PR (closed Jan 18, 2024)',
    );
  });

  it('should sort PRs by number', () => {
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

  it('should group by app and show environments', () => {
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
    expect(result).toContain('**test-api** (staging)');
    expect(result).toContain('**test-app**');
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
    ];

    const result = formatCleanupChanges(changes);
    expect(result).toContain('**test-app** (dev, staging)');
  });

  it('should handle missing closed date', () => {
    const changes: CleanupChange[] = [
      {
        prNumber: 123,
        prTitle: 'No date PR',
        prURL: 'https://github.com/owner/repo/pull/123',
        appName: 'test-app',
        environment: 'dev',
        closedAt: null,
      },
    ];

    const result = formatCleanupChanges(changes);
    expect(result).toContain(
      '- PR [#123](https://github.com/owner/repo/pull/123): No date PR',
    );
    expect(result).not.toContain('(closed');
  });
});
