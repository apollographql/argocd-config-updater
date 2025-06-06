import { cleanupClosedPrTracking } from '../src/index';
import { GitHubClient } from '../src/github';
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
      return { state: state || 'open' };
    },
  };
}

describe('cleanupClosedPrTracking', () => {
  it('should replace closed PR references with main', async () => {
    const contents = `
global:
  gitConfig:
    repoURL: https://github.com/owner/repo
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
    });

    expect((result.contents.match(/track: main/g) || []).length).toBe(2);
  });

  it('should not change pr references that are open', async () => {
    const contents = `
global:
  gitConfig:
    repoURL: https://github.com/owner/repo
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
    });

    expect(result.contents).toContain('track: pr-100');
    expect(result.contents).toContain('track: main');
  });

  it('should handle PR lookup errors by leaving PR references unchanged', async () => {
    const contents = `
global:
  gitConfig:
    repoURL: https://github.com/owner/repo
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
    });

    expect(result.contents).toContain('track: pr-999');
  });

  it('should not modify YAML unnecessarily', async () => {
    const contents = `# Top level comment
global:
  gitConfig:
    repoURL: https://github.com/owner/repo
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
    });

    expect(result.contents).toContain('# Top level comment');
    expect(result.contents).toContain('# Inline comment');
    expect((result.contents.match(/track: main/g) || []).length).toBe(2);
  });
});
