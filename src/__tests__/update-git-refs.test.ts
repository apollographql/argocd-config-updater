import { describe, it, expect } from 'vitest';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { GitHubClient } from '../github.js';
import { updateGitRefs } from '../update-git-refs.js';
import { PrefixingLogger } from '../log.js';

const mockGitHubClient: GitHubClient = {
  async resolveRefToSHA({ ref }) {
    if (ref === 'make-it-numeric') {
      return '12345678';
    }
    return `immutable-${ref}-hooray`;
  },
  async getTreeSHAForPath() {
    return `${Math.random()}`;
  },
  async getCommitSHAsForPath() {
    return [];
  },
  async getPullRequest() {
    return { state: 'open', title: 'Test PR', closedAt: null };
  },
};

const logger = PrefixingLogger.silent();

async function fixture(filename: string): Promise<string> {
  return await readFile(
    join(__dirname, '__fixtures__', 'update-git-refs', filename),
    'utf-8',
  );
}

describe('action', () => {
  it('updates git refs', async () => {
    const contents = await fixture('sample.yaml');
    const newContents = await updateGitRefs(
      contents,
      mockGitHubClient,
      new Set<string>(),
      logger,
    );
    expect(newContents).toMatchSnapshot();

    // It should be idempotent in this case.
    expect(
      await updateGitRefs(
        newContents,
        mockGitHubClient,
        new Set<string>(),
        logger,
      ),
    ).toBe(newContents);

    // Update the first one again but freeze one environment.
    expect(
      await updateGitRefs(
        contents,
        mockGitHubClient,
        new Set<string>(['some-service-dev1']),
        logger,
      ),
    ).toMatchSnapshot();
  });

  it('updates git ref when repoURL/path are in `global`', async () => {
    const contents = await fixture('global.yaml');
    expect(
      await updateGitRefs(
        contents,
        mockGitHubClient,
        new Set<string>(),
        logger,
      ),
    ).toMatchSnapshot();
  });

  it('only changes ref when tree sha changes', async () => {
    let treeSHAForNew = 'aaaa';
    const mockGithubClientTreeSHA: GitHubClient = {
      async resolveRefToSHA({ ref }) {
        return ref === 'main' ? 'new' : 'old';
      },
      async getTreeSHAForPath({ commitSHA }) {
        return commitSHA === 'old' ? 'aaaa' : treeSHAForNew;
      },
      async getCommitSHAsForPath() {
        return [];
      },
      async getPullRequest() {
        return { state: 'open', title: 'Test PR', closedAt: null };
      },
    };

    const contents = await fixture('tree-sha.yaml');

    // First snapshot: ref should still be 'old' because tree SHA matches.
    expect(
      await updateGitRefs(
        contents,
        mockGithubClientTreeSHA,
        new Set<string>(),
        logger,
      ),
    ).toMatchSnapshot();

    treeSHAForNew = 'bbbb';
    // Second snapshot: ref should now be 'new' because tree SHA has changed.
    expect(
      await updateGitRefs(
        contents,
        mockGithubClientTreeSHA,
        new Set<string>(),
        logger,
      ),
    ).toMatchSnapshot();
  });

  it('handles unknown current ref', async () => {
    const mockGithubClientTreeSHA: GitHubClient = {
      async resolveRefToSHA({ ref }) {
        if (ref === 'old') {
          throw Error('unknown ref');
        }
        return 'new';
      },
      async getTreeSHAForPath() {
        return 'aaaa';
      },
      async getCommitSHAsForPath() {
        return [];
      },
      async getPullRequest() {
        return { state: 'open', title: 'Test PR', closedAt: null };
      },
    };

    const contents = await fixture('tree-sha.yaml');

    expect(
      await updateGitRefs(
        contents,
        mockGithubClientTreeSHA,
        new Set<string>(),
        logger,
      ),
    ).toMatchSnapshot();
  });

  it('handle docker tag', async () => {
    const mockGithubClientTreeSHA: GitHubClient = {
      async resolveRefToSHA({ ref }) {
        return ref === 'main' ? 'new' : ref;
      },
      async getTreeSHAForPath({ commitSHA }) {
        return commitSHA === 'd97b3a3240' ? 'bad' : 'aaaa';
      },
      async getCommitSHAsForPath() {
        return [];
      },
      async getPullRequest() {
        return { state: 'open', title: 'Test PR', closedAt: null };
      },
    };

    const contents = await fixture('docker-tree-sha.yaml');

    expect(
      await updateGitRefs(
        contents,
        mockGithubClientTreeSHA,
        new Set<string>(),
        logger,
      ),
    ).toMatchSnapshot();
  });

  it('handle docker tag with unknown commit', async () => {
    const mockGithubClientTreeSHA: GitHubClient = {
      async resolveRefToSHA({ ref }) {
        if (ref === 'd97b3a3240') {
          throw Error('unknown commit');
        }
        return ref === 'main' ? 'new' : ref;
      },
      async getTreeSHAForPath({ commitSHA }) {
        return commitSHA === 'old' ? 'oldaaaa' : 'aaaa';
      },
      async getCommitSHAsForPath() {
        return [];
      },
      async getPullRequest() {
        return { state: 'open', title: 'Test PR', closedAt: null };
      },
    };

    const contents = await fixture('docker-tree-sha.yaml');

    expect(
      await updateGitRefs(
        contents,
        mockGithubClientTreeSHA,
        new Set<string>(),
        logger,
      ),
    ).toMatchSnapshot();
  });
});
