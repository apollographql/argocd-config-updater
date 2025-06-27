import { setImmediate } from 'timers/promises';
import { CachingDockerRegistryClient } from '../src/artifactRegistry';
import { CachingGitHubClient } from '../src/github';

describe('CachingDockerRegistryClient caches', () => {
  it('getAllEquivalentTags caches', async () => {
    let call = 0;
    const client = new CachingDockerRegistryClient({
      async getAllEquivalentTags() {
        return [(++call).toString()];
      },
      async getGitCommitsBetweenTags() {
        return { type: 'no-commits' };
      },
    });

    async function exp(
      dockerImageRepository: string,
      tag: string,
      ret: string,
    ): Promise<void> {
      expect(
        await client.getAllEquivalentTags({ dockerImageRepository, tag }),
      ).toStrictEqual([ret]);
    }

    await exp('x', 'y', '1');
    await exp('x', 'y', '1');
    await exp('x', 'z', '2');
    await exp('w', 'y', '3');
    await exp('x', 'y', '1');
  });
});

describe('CachingGitHubClient caches', () => {
  it('resolveRefToSHA caches', async () => {
    let call = 0;
    const client = new CachingGitHubClient({
      async resolveRefToSHA() {
        // Yield so that the parallel calls are parallel.
        await setImmediate();
        return (++call).toString();
      },
      async getTreeSHAForPath() {
        return '';
      },
      async getCommitSHAsForPath() {
        return [];
      },
      async getPullRequest() {
        return { state: 'open', title: 'Test PR', closedAt: null };
      },
    });

    async function exp(
      repoURL: string,
      ref: string,
      ret: string,
    ): Promise<void> {
      expect(await client.resolveRefToSHA({ repoURL, ref })).toBe(ret);
    }

    await exp('x', 'y', '1');
    await exp('x', 'y', '1');
    await exp('x', 'z', '2');
    await exp('w', 'y', '3');
    await exp('x', 'y', '1');

    // Now try fetching two in parallel. We should only do one underlying fetch.
    const p1 = client.resolveRefToSHA({ repoURL: 'a', ref: 'b' });
    const p2 = client.resolveRefToSHA({ repoURL: 'a', ref: 'b' });
    expect(await p1).toBe('4');
    expect(await p2).toBe('4');
  });
  it('getTreeSHAForPath caches', async () => {
    let call = 0;
    const client = new CachingGitHubClient({
      async resolveRefToSHA() {
        return '';
      },
      async getTreeSHAForPath() {
        return (++call).toString();
      },
      async getCommitSHAsForPath() {
        return [];
      },
      async getPullRequest() {
        return { state: 'open', title: 'Test PR', closedAt: null };
      },
    });

    async function exp(
      repoURL: string,
      commitSHA: string,
      path: string,
      ret: string,
    ): Promise<void> {
      expect(await client.getTreeSHAForPath({ repoURL, commitSHA, path })).toBe(
        ret,
      );
    }

    await exp('x', 'y', 'p', '1');
    await exp('x', 'y', 'p', '1');
    await exp('x', 'z', 'p', '2');
    await exp('w', 'y', 'p', '3');
    await exp('x', 'y', 'p', '1');
    await exp('x', 'y', 'pp', '4');
  });
});
