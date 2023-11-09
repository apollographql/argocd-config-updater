import { getOctokit } from '@actions/github';

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
    const sha = (
      await this.octokit.rest.repos.getCommit({
        owner,
        repo,
        ref,
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
