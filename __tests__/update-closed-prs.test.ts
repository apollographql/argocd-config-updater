import { GitHubClient } from '../src/github';
import { PrefixingLogger } from '../src/log';
import { cleanupClosedPrTracking } from '../src/update-closed-prs';

const mockGitHubClient: GitHubClient = {
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
    if (prNumber === 123) {
      return {
        state: 'closed' as const,
        title: 'Test closed PR',
        closedAt: '2024-01-15T10:30:00Z',
      };
    }
    return {
      state: 'open' as const,
      title: 'Test open PR',
      closedAt: null,
    };
  },
};

const logger = PrefixingLogger.silent();

describe('cleanupClosedPrTracking', () => {
  it('should extract app name from file path correctly', async () => {
    const yamlContent = `
dev:
  gitConfig:
    repoURL: https://github.com/test/repo.git
    path: services/test
    ref: abcdef
    trackMutableRef: pr-123
`;

    const result = await cleanupClosedPrTracking({
      contents: yamlContent,
      frozenEnvironments: new Set(),
      gitHubClient: mockGitHubClient,
      logger,
      filename: 'teams/governance/operationcollections/application-values.yaml',
    });

    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toMatchObject({
      prNumber: 123,
      prTitle: 'Test closed PR',
      appName: 'operationcollections',
      environment: 'dev',
      closedAt: '2024-01-15T10:30:00Z',
    });
  });

  it('should handle different file path patterns', async () => {
    const yamlContent = `
staging:
  gitConfig:
    repoURL: https://github.com/test/repo.git
    path: services/test
    ref: abcdef
    trackMutableRef: pr-123
`;

    const result = await cleanupClosedPrTracking({
      contents: yamlContent,
      frozenEnvironments: new Set(),
      gitHubClient: mockGitHubClient,
      logger,
      filename: '/path/to/teams/apollo-router/application-values.yaml',
    });

    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toMatchObject({
      appName: 'apollo-router',
      environment: 'staging',
    });
  });

  it('should handle fallback app name extraction', async () => {
    const yamlContent = `
prod:
  gitConfig:
    repoURL: https://github.com/test/repo.git
    path: services/test
    ref: abcdef
    trackMutableRef: pr-123
`;

    const result = await cleanupClosedPrTracking({
      contents: yamlContent,
      frozenEnvironments: new Set(),
      gitHubClient: mockGitHubClient,
      logger,
      filename: 'some-config.yaml',
    });

    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toMatchObject({
      appName: 'some-config',
      environment: 'prod',
    });
  });

  it('should not track open PRs', async () => {
    const yamlContent = `
dev:
  gitConfig:
    repoURL: https://github.com/test/repo.git
    path: services/test
    ref: abcdef
    trackMutableRef: pr-456
`;

    const result = await cleanupClosedPrTracking({
      contents: yamlContent,
      frozenEnvironments: new Set(),
      gitHubClient: mockGitHubClient,
      logger,
      filename: 'teams/test-app/application-values.yaml',
    });

    expect(result.changes).toHaveLength(0);
  });
});
