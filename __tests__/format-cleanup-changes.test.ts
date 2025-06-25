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
      },
    ];

    const result = formatCleanupChanges(changes);
    expect(result).toContain('Found 1 closed PR:');
    expect(result).toContain(
      '- PR [#123](https://github.com/owner/repo/pull/123): Add new feature',
    );
  });

  it('should find multiple closed PRs', () => {
    const changes: CleanupChange[] = [
      {
        prNumber: 456,
        prTitle: 'Second PR',
        prURL: 'https://github.com/owner/repo/pull/456',
      },
      {
        prNumber: 123,
        prTitle: 'First PR',
        prURL: 'https://github.com/owner/repo/pull/123',
      },
    ];

    const result = formatCleanupChanges(changes);
    expect(result).toContain('Found 2 closed PRs:');
    expect(result).toContain(
      '- PR [#123](https://github.com/owner/repo/pull/123): First PR',
    );
    expect(result).toContain(
      '- PR [#456](https://github.com/owner/repo/pull/456): Second PR',
    );
  });

  it('should sort PRs by number', () => {
    const changes: CleanupChange[] = [
      {
        prNumber: 456,
        prTitle: 'Second PR',
        prURL: 'https://github.com/owner/repo/pull/456',
      },
      {
        prNumber: 123,
        prTitle: 'First PR',
        prURL: 'https://github.com/owner/repo/pull/123',
      },
    ];

    const result = formatCleanupChanges(changes);
    const lines = result.split('\n');
    const pr123Index = lines.findIndex((line) => line.includes('#123'));
    const pr456Index = lines.findIndex((line) => line.includes('#456'));
    expect(pr123Index).toBeLessThan(pr456Index);
  });
});
