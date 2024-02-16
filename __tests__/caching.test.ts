import { CachingDockerRegistryClient } from '../src/artifactRegistry';
import { CachingGitHubClient } from '../src/github';

describe('CachingDockerRegistryClient caches', () => {
  it('getAllEquivalentTags caches', async () => {
    let call = 0;
    const client = new CachingDockerRegistryClient({
      async getAllEquivalentTags() {
        return [(++call).toString()];
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
  it('resolveRefToSha caches', async () => {
    let call = 0;
    const client = new CachingGitHubClient({
      async resolveRefToSha() {
        return (++call).toString();
      },
      async getTreeSHAForPath() {
        return '';
      },
    });

    async function exp(
      repoURL: string,
      ref: string,
      ret: string,
    ): Promise<void> {
      expect(await client.resolveRefToSha({ repoURL, ref })).toBe(ret);
    }

    await exp('x', 'y', '1');
    await exp('x', 'y', '1');
    await exp('x', 'z', '2');
    await exp('w', 'y', '3');
    await exp('x', 'y', '1');
  });
  it('getTreeSHAForPath caches', async () => {
    let call = 0;
    const client = new CachingGitHubClient({
      async resolveRefToSha() {
        return '';
      },
      async getTreeSHAForPath() {
        return (++call).toString();
      },
    });

    async function exp(
      repoURL: string,
      ref: string,
      path: string,
      ret: string,
    ): Promise<void> {
      expect(await client.getTreeSHAForPath({ repoURL, ref, path })).toBe(ret);
    }

    await exp('x', 'y', 'p', '1');
    await exp('x', 'y', 'p', '1');
    await exp('x', 'z', 'p', '2');
    await exp('w', 'y', 'p', '3');
    await exp('x', 'y', 'p', '1');
    await exp('x', 'y', 'pp', '4');
  });
});
