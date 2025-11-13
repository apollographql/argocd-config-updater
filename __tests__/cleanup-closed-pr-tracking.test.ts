import { describe, it, expect } from 'vitest';
import { cleanupClosedPrTracking } from '../src/update-closed-prs';
import { getWebURL, GitHubClient } from '../src/github';
import { PrefixingLogger } from '../src/log';

const logger = PrefixingLogger.silent();

function createMockGitHubClient(
  prStates: Record<number, 'open' | 'closed' | 'error'>,
): GitHubClient {
  return {
    async resolveRefToSHA() {
      return 'mock-sha';
    },
    async getTreeSHAForPath() {
      return 'mock-tree-sha';
    },
    async getCommitSHAsForPath() {
      return [];
    },
    async getPullRequest({ prNumber }) {
      const state = prStates[prNumber];
      if (state === 'error') {
        throw new Error('Not found');
      }
      return {
        state: state || 'open',
        title: `PR ${prNumber} title`,
        closedAt: state === 'closed' ? '2024-01-15T10:30:00Z' : null,
      };
    },
  };
}

describe('getWebURL', () => {
  it('should return a github web url given different repo url formats', () => {
    // Standard .git URLs
    expect(getWebURL('https://github.com/owner/repo.git')).toBe(
      'https://github.com/owner/repo',
    );
    // URLs without .git
    expect(getWebURL('https://github.com/owner/repo')).toBe(
      'https://github.com/owner/repo',
    );
  });
});

describe('cleanupClosedPrTracking', () => {
  it('should replace closed PR references with main', async () => {
    const contents = `
global:
  gitConfig:
    repoURL: https://github.com/owner/repo.git
    path: some/path
dev:
  track: pr-123
  gitConfig:
    ref: c0ffee
staging:
  track: main
  gitConfig:
    ref: c0ffee
prod:
  promote:
    from: staging
`;

    const gitHubClient = createMockGitHubClient({
      123: 'closed',
    });

    const result = await cleanupClosedPrTracking({
      contents,
      gitHubClient,
      logger,
      frozenEnvironments: new Set(),
      filename: 'teams/test-team/test-app/application-values.yaml',
    });

    expect(result.contents).not.toContain('track: pr-123');
    expect((result.contents.match(/track: main/g) || []).length).toBe(2);
    expect(result.contents).toMatchSnapshot();
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toMatchObject({
      prNumber: 123,
      prTitle: 'PR 123 title',
      prURL: 'https://github.com/owner/repo/pull/123',
      filename: 'teams/test-team/test-app/application-values.yaml',
      environment: 'dev',
      closedAt: '2024-01-15T10:30:00Z',
    });
  });

  it('should not change pr references that are open', async () => {
    const contents = `
global:
  gitConfig:
    repoURL: https://github.com/owner/repo.git
    path: some/path
dev:
  track: pr-100
  gitConfig:
    ref: c0ffee
staging:
  track: pr-123
  gitConfig:
    ref: c0ffee
prod:
  promote:
    from: staging
`;

    const gitHubClient = createMockGitHubClient({
      123: 'closed',
      100: 'open',
    });

    const result = await cleanupClosedPrTracking({
      contents,
      gitHubClient,
      logger,
      frozenEnvironments: new Set(),
      filename: 'teams/test-team/test-app/application-values.yaml',
    });

    expect(result.contents).toContain('track: pr-100');
    expect(result.contents).not.toContain('track: pr-123');
    expect(result.contents).toContain('track: main');
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0].prNumber).toBe(123);
    expect(result.contents).toMatchSnapshot();
  });

  it('should handle PR lookup errors by leaving PR references unchanged', async () => {
    const contents = `
global:
  gitConfig:
    repoURL: https://github.com/owner/repo.git
    path: some/path
dev:
  track: pr-999
  gitConfig:
    ref: c0ffee
`;

    const gitHubClient = createMockGitHubClient({
      999: 'error',
    });

    const result = await cleanupClosedPrTracking({
      contents,
      gitHubClient,
      logger,
      frozenEnvironments: new Set(),
      filename: 'teams/test-team/test-app/application-values.yaml',
    });

    expect(result.contents).toContain('track: pr-999');
    expect(result.contents).toMatchSnapshot();
    expect(result.changes).toHaveLength(0);
  });

  it('should not modify YAML unnecessarily', async () => {
    const contents = `# Top level comment
global:
  gitConfig:
    repoURL: https://github.com/owner/repo.git
    path: some/path
# Development environment
dev:
  track: pr-123  # Inline comment
  gitConfig:
    ref: c0ffee
staging:
  track: main  # Also tracking main
  gitConfig:
    ref: deadbeef
prod:
  promote:
    from: staging  # Promote from staging
`;

    const gitHubClient = createMockGitHubClient({
      123: 'closed',
    });

    const result = await cleanupClosedPrTracking({
      contents,
      gitHubClient,
      logger,
      frozenEnvironments: new Set(),
      filename: 'teams/test-team/test-app/application-values.yaml',
    });

    expect(result.contents).toContain('# Top level comment');
    expect(result.contents).toContain('# Inline comment');
    expect((result.contents.match(/track: main/g) || []).length).toBe(2);
    expect(result.contents).toMatchSnapshot();
    expect(result.changes).toHaveLength(1);
  });
});
