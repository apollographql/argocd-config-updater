import * as core from '@actions/core';
import { getOctokit } from '@actions/github';
import { LRUCache } from 'lru-cache';

export interface ResolveRefToSHAOptions {
  repoURL: string;
  ref: string;
}

export interface GetTreeSHAForPathOptions {
  repoURL: string;
  commitSHA: string;
  path: string;
}

export interface CompareCommitsOptions {
  repoURL: string;
  baseCommitSHA: string;
  headCommitSHA: string;
}

export interface CompareCommitsResult {
  commits: {
    commitSHA: string;
    message: string;
    author: string | null;
    commitUrl: string;
  }[];
}

export interface GitHubClient {
  resolveRefToSHA(options: ResolveRefToSHAOptions): Promise<string>;
  getTreeSHAForPath(options: GetTreeSHAForPathOptions): Promise<string | null>;
  compareCommits(
    options: CompareCommitsOptions,
  ): Promise<CompareCommitsResult | null>;
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

interface AllTreesForCommit {
  pathToTreeSHA: Map<string, string>;
  // If true, GitHub's response to the recursive tree fetch was truncated, so on
  // cache miss we fall back to the getContent API.
  truncated: boolean;
}
export class OctokitGitHubClient {
  apiCalls = new Map<string, number>();
  constructor(private octokit: ReturnType<typeof getOctokit>) {}

  async compareCommits({
    repoURL,
    baseCommitSHA,
    headCommitSHA,
  }: CompareCommitsOptions): Promise<CompareCommitsResult | null> {
    const baseIsCommitSHA = baseCommitSHA.match(/([0-9a-fA-F]+)$/);
    const headIsCommitSHA = headCommitSHA.match(/([0-9a-fA-F]+)$/);
    if (!baseIsCommitSHA || !headIsCommitSHA) return null;

    const { owner, repo } = parseRepoURL(repoURL);

    // Include '^' to be inclusive of the head commit.
    const basehead = `${baseCommitSHA}...${headCommitSHA}^`;
    this.logAPICall('repos.compareCommits', `${owner}/${repo} ${basehead}`);
    try {
      const result = (
        await this.octokit.rest.repos.compareCommitsWithBasehead({
          owner,
          repo,
          basehead,
        })
      ).data.commits;
      return {
        commits: result.map((commit) => ({
          commitSHA: commit.sha,
          message: commit.commit.message,
          author: commit.author?.name ?? commit.commit.author?.email ?? null,
          commitUrl: commit.html_url,
        })),
      };
    } catch (error: unknown) {
      core.info(`[GH API] Error in compareCommits, ignoring`);
      return null;
    }
  }

  private logAPICall(name: string, description: string): void {
    core.info(`[GH API]${name} ${description}`);
    this.apiCalls.set(name, (this.apiCalls.get(name) ?? 0) + 1);
  }

  // The cache key is JSON-ification of `{ repoURL, commitSHA }`.
  private allTreesForCommitCache = new LRUCache<
    string,
    AllTreesForCommit,
    { repoURL: string; commitSHA: string }
  >({
    max: 1024,
    // We ignore the key itself and treat the context as the key
    // (the key is just the JSON-ification of context).
    fetchMethod: async (_key, _staleValue, { context }) => {
      const { repoURL, commitSHA } = context;
      const { owner, repo } = parseRepoURL(repoURL);
      this.logAPICall('git.getCommit', `${owner} / ${repo} ${commitSHA}`);
      const rootTreeSHA = (
        await this.octokit.rest.git.getCommit({
          owner,
          repo,
          commit_sha: commitSHA,
        })
      ).data.tree.sha;
      this.logAPICall('git.getTree', `${owner} / ${repo} ${rootTreeSHA}`);
      const { tree, truncated } = (
        await this.octokit.rest.git.getTree({
          owner,
          repo,
          tree_sha: rootTreeSHA,
          recursive: 'true',
        })
      ).data;
      const allTreesForCommit: AllTreesForCommit = {
        pathToTreeSHA: new Map(),
        truncated,
      };
      for (const { path, type, sha } of tree) {
        if (
          type === 'tree' &&
          typeof path === 'string' &&
          typeof sha === 'string'
        ) {
          allTreesForCommit.pathToTreeSHA.set(path, sha);
        }
      }
      // Also set the root itself in case we're tracking the root of a repo for
      // some reason.
      allTreesForCommit.pathToTreeSHA.set('', rootTreeSHA);
      return allTreesForCommit;
    },
  });

  async resolveRefToSHA({
    repoURL,
    ref,
  }: ResolveRefToSHAOptions): Promise<string> {
    // If the ref already looks like a SHA, just return it.
    // This does not validate that the commit actually exists in the repo,
    // but in practice the next thing we're going to do is call getTreeSHAForPath
    // with the SHA and that will apply that validation.
    if (ref.match(/^[0-9a-f]{40}$/)) {
      return ref;
    }
    const { owner, repo } = parseRepoURL(repoURL);
    const prNumber = ref.match(/^pr-([0-9]+)$/)?.[1];
    const refParameter = prNumber ? `pull / ${prNumber} / head` : ref;
    this.logAPICall('repos.getCommit', `${owner} / ${repo} ${refParameter}`);
    const sha = (
      await this.octokit.rest.repos.getCommit({
        owner,
        repo,
        ref: refParameter,
        mediaType: {
          format: 'sha',
        },
      })
    ).data as unknown;
    // The TS types don't understand that `mediaType: { format: 'sha' }` turns
    // `.data` into a string, so we have to cast to `unknown` and check
    // ourselves.
    if (typeof sha !== 'string') {
      throw Error('Expected string response');
    }
    return sha;
  }

  async getTreeSHAForPath({
    repoURL,
    commitSHA,
    path,
  }: GetTreeSHAForPathOptions): Promise<string | null> {
    const allTreesForCommit = await this.allTreesForCommitCache.fetch(
      JSON.stringify({ repoURL, commitSHA }),
      { context: { repoURL, commitSHA } },
    );
    if (!allTreesForCommit) {
      // This shouldn't happen: errors should lead to an error being thrown from
      // the previous line, but the fetchMethod always returns an actual item.
      throw Error(`Unexpected missing entry in allTreesForCommitCache`);
    }
    const shaFromCache = allTreesForCommit.pathToTreeSHA.get(path);
    if (shaFromCache) {
      return shaFromCache;
    }
    if (!allTreesForCommit.truncated) {
      // The recursive listing we got from GitHub is complete, so if it doesn't
      // have the tree in question, then the path just doesn't exist (as a tree)
      // at the given commit.
      return null;
    }
    // Hmm, we haven't heard of this tree but our listing was truncated. Fall
    // back to the one-at-a-time API.
    return this.getTreeSHAForPathViaGetContent({ repoURL, commitSHA, path });
  }

  // Fall back to asking the GitHub API for the tree hash directly if our cache
  // was truncated.
  private async getTreeSHAForPathViaGetContent({
    repoURL,
    commitSHA,
    path,
  }: GetTreeSHAForPathOptions): Promise<string | null> {
    const { owner, repo } = parseRepoURL(repoURL);
    this.logAPICall('repos.getContent', `${owner} / ${repo} ${commitSHA}`);
    let data;
    try {
      data = (
        await this.octokit.rest.repos.getContent({
          owner,
          repo,
          ref: commitSHA,
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
  constructor(
    private wrapped: GitHubClient,
    dump?: CachingGitHubClientDump,
  ) {
    if (dump) {
      this.getTreeSHAForPathCache.load(dump.treeSHAs);
    }
  }

  private resolveRefToSHACache = new LRUCache<
    string,
    string,
    ResolveRefToSHAOptions
  >({
    max: 1024,
    fetchMethod: async (_key, _staleValue, { context }) => {
      return this.wrapped.resolveRefToSHA(context);
    },
  });

  private getTreeSHAForPathCache = new LRUCache<
    string,
    // LRUCache can't store null, so we box it.
    { boxed: string | null },
    GetTreeSHAForPathOptions
  >({
    max: 1024,
    fetchMethod: async (_key, _staleValue, { context }) => {
      return { boxed: await this.wrapped.getTreeSHAForPath(context) };
    },
  });

  async resolveRefToSHA(options: ResolveRefToSHAOptions): Promise<string> {
    const sha = await this.resolveRefToSHACache.fetch(JSON.stringify(options), {
      context: options,
    });
    if (!sha) {
      throw Error(
        'resolveRefToSHACache.fetch should never resolve without a real SHA',
      );
    }
    return sha;
  }

  async getTreeSHAForPath(
    options: GetTreeSHAForPathOptions,
  ): Promise<string | null> {
    const cached = await this.getTreeSHAForPathCache.fetch(
      JSON.stringify(options),
      {
        context: options,
      },
    );
    if (!cached) {
      throw Error(
        'getTreeSHAForPathCache.fetch should never resolve without a boxed value',
      );
    }
    return cached.boxed;
  }

  async compareCommits(
    options: CompareCommitsOptions,
  ): Promise<CompareCommitsResult | null> {
    return this.wrapped.compareCommits(options);
  }

  dump(): CachingGitHubClientDump {
    // We don't dump resolveRefToSHACache because it is not immutable (it tracks
    // the current commits on main, etc).
    return { treeSHAs: this.getTreeSHAForPathCache.dump() };
  }
}

export interface CachingGitHubClientDump {
  treeSHAs: [
    string,
    LRUCache.Entry<{
      boxed: string | null;
    }>,
  ][];
}

export function isCachingGitHubClientDump(
  dump: unknown,
): dump is CachingGitHubClientDump {
  if (!dump || typeof dump !== 'object') {
    return false;
  }
  if (!('treeSHAs' in dump)) {
    return false;
  }
  const { treeSHAs } = dump;
  if (!Array.isArray(treeSHAs)) {
    return false;
  }

  // XXX we could check the values further if we want to be more anal
  return true;
}
