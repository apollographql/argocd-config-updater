import { getOctokit } from '@actions/github';
import { LRUCache } from 'lru-cache';

export interface ResolveRefToShaOptions {
  repoURL: string;
  ref: string;
}

export interface GetTreeSHAForPathOptions {
  repoURL: string;
  ref: string;
  path: string;
}

export interface GitHubClient {
  resolveRefToSha(options: ResolveRefToShaOptions): Promise<string>;
  getTreeSHAForPath(options: GetTreeSHAForPathOptions): Promise<string | null>;
}

interface OwnerAndRepo {
  owner: string;
  repo: string;
}

function parseRepoURL(repoURL: string): OwnerAndRepo {
  const m = repoURL.match(/\bgithub\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git|\/)?$/);
  if (!m) {
    throw Error(`Can only track GitHub repoURLs, not ${repoURL}`);
  }
  return { owner: m[1], repo: m[2] };
}

export class OctokitGitHubClient {
  constructor(private octokit: ReturnType<typeof getOctokit>) {}

  async resolveRefToSha({
    repoURL,
    ref,
  }: ResolveRefToShaOptions): Promise<string> {
    const { owner, repo } = parseRepoURL(repoURL);
    const prNumber = ref.match(/^pr-([0-9]+)$/)?.[1];
    const sha = (
      await this.octokit.rest.repos.getCommit({
        owner,
        repo,
        ref: prNumber ? `pull/${prNumber}/head` : ref,
        mediaType: {
          format: 'sha',
        },
      })
    ).data as unknown;
    // The TS types don't understand that `mediaType: {format: 'sha'}` turns
    // `.data` into a string, so we have to cast to `unknown` and check
    // ourselves.
    if (typeof sha !== 'string') {
      throw Error('Expected string response');
    }
    return sha;
  }

  async getTreeSHAForPath({
    repoURL,
    ref,
    path,
  }: GetTreeSHAForPathOptions): Promise<string | null> {
    const { owner, repo } = parseRepoURL(repoURL);
    let data;
    try {
      data = (
        await this.octokit.rest.repos.getContent({
          owner,
          repo,
          ref,
          path,
          mediaType: {
            format: 'object',
          },
        })
      ).data as unknown;
    } catch (e: unknown) {
      // If it looks like "not found" just return null.
      if (typeof e === 'object' && e && 'status' in e && e.status === 404) {
        return null;
      }
      throw e;
    }
    // TS types seem confused here too; this works in practice.
    if (
      !(
        typeof data === 'object' &&
        data !== null &&
        'type' in data &&
        data.type === 'dir' &&
        'sha' in data &&
        typeof data.sha === 'string'
      )
    ) {
      throw Error('response does not appear to be a tree');
    }
    return data.sha;
  }
}

export class CachingGitHubClient {
  constructor(private wrapped: GitHubClient) {}

  private resolveRefToShaCache = new LRUCache<string, string>({ max: 1024 });
  // LRUCache can't store null, so we box it.
  private getTreeSHAForPathCache = new LRUCache<
    string,
    { boxed: string | null }
  >({
    max: 1024,
  });

  async resolveRefToSha(options: ResolveRefToShaOptions): Promise<string> {
    const cacheKey = JSON.stringify(options);
    const cached = this.resolveRefToShaCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }
    const ret = await this.wrapped.resolveRefToSha(options);
    this.resolveRefToShaCache.set(cacheKey, ret);
    return ret;
  }

  async getTreeSHAForPath(
    options: GetTreeSHAForPathOptions,
  ): Promise<string | null> {
    const cacheKey = JSON.stringify(options);
    const cached = this.getTreeSHAForPathCache.get(cacheKey);
    if (cached !== undefined) {
      return cached.boxed;
    }
    const ret = await this.wrapped.getTreeSHAForPath(options);
    this.getTreeSHAForPathCache.set(cacheKey, { boxed: ret });
    return ret;
  }
}
