import { readFile } from 'fs/promises';
import { join } from 'path';
import { GitHubClient } from '../src/github';
import { updateGitRefs } from '../src/update-git-refs';

const mockGitHubClient: GitHubClient = {
  async resolveRefToSha({ ref }) {
    if (ref === 'make-it-numeric') {
      return '12345678';
    }
    return `immutable-${ref}-hooray`;
  },
  async getTreeSHAForPath() {
    return `${Math.random()}`;
  },
};

async function fixture(filename: string): Promise<string> {
  return await readFile(
    join(__dirname, '__fixtures__', 'update-git-refs', filename),
    'utf-8',
  );
}

describe('action', () => {
  it('updates git refs', async () => {
    const contents = await fixture('sample.yaml');
    const newContents = await updateGitRefs(contents, mockGitHubClient);
    expect(newContents).toMatchSnapshot();

    // It should be idempotent in this case.
    expect(await updateGitRefs(newContents, mockGitHubClient)).toBe(
      newContents,
    );
  });

  it('updates git ref when repoURL/path are in `global`', async () => {
    const contents = await fixture('global.yaml');
    expect(await updateGitRefs(contents, mockGitHubClient)).toMatchSnapshot();
  });

  it('only changes ref when tree sha changes', async () => {
    let treeSHAForNew = 'aaaa';
    const mockGithubClientTreeSHA: GitHubClient = {
      async resolveRefToSha() {
        return 'new';
      },
      async getTreeSHAForPath({ ref }) {
        return ref === 'old' ? 'aaaa' : treeSHAForNew;
      },
    };

    const contents = await fixture('tree-sha.yaml');

    // First snapshot: ref should still be 'old' because tree SHA matches.
    expect(
      await updateGitRefs(contents, mockGithubClientTreeSHA),
    ).toMatchSnapshot();

    treeSHAForNew = 'bbbb';
    // Second snapshot: ref should now be 'new' because tree SHA has changed.
    expect(
      await updateGitRefs(contents, mockGithubClientTreeSHA),
    ).toMatchSnapshot();
  });
});
