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
    const yamlContent = `
dev:
  track: pr-123
staging:
  track: main
prod:
  promote:
    from: staging
`;

    const mockGitHubClient = createMockGitHubClient({
      123: 'closed',
    });

    const result = await cleanupClosedPrTracking(
      yamlContent,
      'owner/repo',
      mockGitHubClient,
      logger,
    );

    expect(result.changesCount).toBe(1);
    expect((result.newContents.match(/track: main/g) || []).length).toBe(2);
  });

  it('should not change pr references that are open', async () => {
    const yamlContent = `
dev:
  track: pr-100
staging:
  track: pr-123
prod:
  promote:
    from: staging
`;

    const mockGitHubClient = createMockGitHubClient({
      123: 'closed',
      100: 'open',
    });

    const result = await cleanupClosedPrTracking(
      yamlContent,
      'owner/repo',
      mockGitHubClient,
      logger,
    );

    expect(result.changesCount).toBe(1);
    expect(result.newContents).toContain('track: pr-100');
    expect(result.newContents).toContain('track: main');
  });

  it('should handle PR lookup errors by leaving PR references unchanged', async () => {
    const yamlContent = `
track: pr-999
`;

    const mockGitHubClient = createMockGitHubClient({
      999: 'error',
    });

    const result = await cleanupClosedPrTracking(
      yamlContent,
      'owner/repo',
      mockGitHubClient,
      logger,
    );

    expect(result.changesCount).toBe(0);
    expect(result.newContents).toContain('track: pr-999');
  });
});
