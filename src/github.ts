import { getOctokit } from "@actions/github";
import { LRUCache } from "lru-cache";
import { posix as posixPath } from "path";
import {
  PromotionInfo,
  promotionInfoCommits,
  promotionInfoUnknown,
} from "./promotionInfo.js";
import { PrefixingLogger } from "./log.js";

export interface ResolveRefToSHAOptions {
  repoURL: string;
  ref: string;
}

export interface GetTreeSHAForPathOptions {
  repoURL: string;
  commitSHA: string;
  path: string;
}

export interface GetCommitSHAsForPathOptions {
  repoURL: string;
  ref: string;
  path: string;
}

export interface GetPullRequestForNumberOptions {
  repoURL: string;
  prNumber: number;
}

export type PullRequestState = "open" | "closed";

export interface PullRequest {
  state: PullRequestState;
  title: string;
  closedAt: string | null;
}

export interface GitHubClient {
  resolveRefToSHA(options: ResolveRefToSHAOptions): Promise<string>;
  getTreeSHAForPath(options: GetTreeSHAForPathOptions): Promise<string | null>;
  getCommitSHAsForPath(options: GetCommitSHAsForPathOptions): Promise<string[]>;
  getPullRequest(options: GetPullRequestForNumberOptions): Promise<PullRequest>;
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

/**
 * @param repoURL Git repository URL (e.g., "https://github.com/owner/repo.git")
 * @returns GitHub web URL (e.g., "https://github.com/owner/repo")
 */
export function getWebURL(repoURL: string): string {
  const { owner, repo } = parseRepoURL(repoURL);
  return `https://github.com/${owner}/${repo}`;
}

interface AllTreesForCommit {
  pathToTreeSHA: Map<string, string>;
  // Maps symlink paths to their target paths (the content of the symlink blob).
  pathToSymlinkTarget: Map<string, string>;
  // If true, GitHub's response to the recursive tree fetch was truncated, so on
  // cache miss we fall back to the getContent API.
  truncated: boolean;
}

function isSHA(s: string): boolean {
  return !!s.match(/^[0-9a-f]{40}$/);
}

// Resolves a symlink target relative to the symlink's path.
// For example, if the symlink is at "apps/linter/chart" and points to
// "../../shared/chart", this returns "shared/chart".
// Throws if the target escapes the repository root or is absolute.
export function resolveSymlinkTarget(
  symlinkPath: string,
  target: string,
): string {
  if (target.startsWith("/")) {
    throw new Error(
      `Symlink at ${symlinkPath} has absolute target ${target}, which is not supported`,
    );
  }
  // Get the parent directory of the symlink and join with the target.
  const parentDir = posixPath.dirname(symlinkPath);
  const resolved = posixPath.join(parentDir, target);
  // If the resolved path escapes the repo root, posixPath.join will return
  // a path starting with ".."
  if (resolved.startsWith("..")) {
    throw new Error(
      `Symlink at ${symlinkPath} points to ${target}, which escapes the repository root`,
    );
  }
  return resolved;
}

export class OctokitGitHubClient {
  apiCalls = new Map<string, number>();
  constructor(
    private octokit: ReturnType<typeof getOctokit>,
    private logger: PrefixingLogger,
  ) {}

  private logAPICall(name: string, description: string): void {
    this.logger.info(`[GH API] ${name} ${description}`);
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
      this.logAPICall("git.getCommit", `${owner} / ${repo} ${commitSHA}`);
      const rootTreeSHA = (
        await this.octokit.rest.git.getCommit({
          owner,
          repo,
          commit_sha: commitSHA,
        })
      ).data.tree.sha;
      this.logAPICall("git.getTree", `${owner} / ${repo} ${rootTreeSHA}`);
      const { tree, truncated } = (
        await this.octokit.rest.git.getTree({
          owner,
          repo,
          tree_sha: rootTreeSHA,
          recursive: "true",
        })
      ).data;
      const allTreesForCommit: AllTreesForCommit = {
        pathToTreeSHA: new Map(),
        pathToSymlinkTarget: new Map(),
        truncated,
      };
      const symlinkSHAs: { path: string; sha: string }[] = [];
      for (const { path, type, sha, mode } of tree) {
        if (typeof path === "string" && typeof sha === "string") {
          if (type === "tree") {
            allTreesForCommit.pathToTreeSHA.set(path, sha);
          } else if (type === "blob" && mode === "120000") {
            // Symlinks have mode 120000. In the recursive tree API they show up
            // as type "blob" rather than "symlink", so we detect them by mode.
            symlinkSHAs.push({ path, sha });
          }
        }
      }
      // Fetch the content of each symlink blob to get its target path.
      for (const { path, sha } of symlinkSHAs) {
        this.logAPICall("git.getBlob", `${owner} / ${repo} ${sha}`);
        const blobData = await this.octokit.rest.git.getBlob({
          owner,
          repo,
          file_sha: sha,
        });
        // Symlink target is stored as base64-encoded content.
        const target = Buffer.from(blobData.data.content, "base64").toString(
          "utf-8",
        );
        allTreesForCommit.pathToSymlinkTarget.set(path, target);
      }
      // Also set the root itself in case we're tracking the root of a repo for
      // some reason.
      allTreesForCommit.pathToTreeSHA.set("", rootTreeSHA);
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
    if (isSHA(ref)) {
      return ref;
    }
    const { owner, repo } = parseRepoURL(repoURL);
    const prNumber = ref.match(/^pr-([0-9]+)$/)?.[1];
    const refParameter = prNumber ? `pull/${prNumber}/head` : ref;
    this.logAPICall("repos.getCommit", `${owner}/${repo} ${refParameter}`);
    const sha = (
      await this.octokit.rest.repos.getCommit({
        owner,
        repo,
        ref: refParameter,
        mediaType: {
          format: "sha",
        },
      })
    ).data as unknown;
    // The TS types don't understand that `mediaType: { format: 'sha' }` turns
    // `.data` into a string, so we have to cast to `unknown` and check
    // ourselves.
    if (typeof sha !== "string") {
      throw Error("Expected string response");
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
    // Check if the path is a symlink and follow it (one level only).
    const symlinkTarget = allTreesForCommit.pathToSymlinkTarget.get(path);
    if (symlinkTarget) {
      const resolvedPath = resolveSymlinkTarget(path, symlinkTarget);
      const resolvedSHA = allTreesForCommit.pathToTreeSHA.get(resolvedPath);
      if (resolvedSHA) {
        return resolvedSHA;
      }
      // If the resolved path wasn't in the cache, fall through to the truncated
      // check below.
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
    this.logAPICall("repos.getContent", `${owner} / ${repo} ${commitSHA}`);
    let data;
    try {
      data = (
        await this.octokit.rest.repos.getContent({
          owner,
          repo,
          ref: commitSHA,
          path,
          mediaType: {
            format: "object",
          },
        })
      ).data as unknown;
    } catch (e: unknown) {
      // If it looks like "not found" just return null.
      if (typeof e === "object" && e && "status" in e && e.status === 404) {
        return null;
      }
      throw e;
    }
    // TS types seem confused here too; this works in practice.
    if (
      typeof data === "object" &&
      data !== null &&
      "type" in data &&
      data.type === "dir" &&
      "sha" in data &&
      typeof data.sha === "string"
    ) {
      return data.sha;
    }
    // If it's a symlink, follow it (one level only).
    if (
      typeof data === "object" &&
      data !== null &&
      "type" in data &&
      data.type === "symlink" &&
      "target" in data &&
      typeof data.target === "string"
    ) {
      const resolvedPath = resolveSymlinkTarget(path, data.target);
      return this.getTreeSHAForPathViaGetContent({
        repoURL,
        commitSHA,
        path: resolvedPath,
      });
    }
    throw Error("response does not appear to be a tree or symlink");
  }

  async getCommitSHAsForPath({
    repoURL,
    ref,
    path,
  }: GetCommitSHAsForPathOptions): Promise<string[]> {
    const { owner, repo } = parseRepoURL(repoURL);
    this.logAPICall("repos.listCommits", `${owner}/${repo}@${ref} ${path}`);
    return (
      await this.octokit.rest.repos.listCommits({
        owner,
        repo,
        path,
        sha: ref,
        per_page: 100, // max allowed
      })
    ).data
      .map(({ sha }) => sha)
      .reverse(); // Chronological order
  }

  async getPullRequest({
    repoURL,
    prNumber,
  }: GetPullRequestForNumberOptions): Promise<PullRequest> {
    const { owner, repo } = parseRepoURL(repoURL);
    this.logAPICall("pulls.get", `${owner}/${repo} #${prNumber}`);
    const response = await this.octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
    });
    return {
      state: response.data.state as PullRequestState,
      title: response.data.title,
      closedAt: response.data.closed_at,
    };
  }
}

export class CachingGitHubClient {
  constructor(
    private wrapped: GitHubClient,
    dump?: CachingGitHubClientDump | null,
  ) {
    if (dump) {
      this.getTreeSHAForPathCache.load(dump.treeSHAs);
      // Support old cache files that don't have commitSHAs.
      if (dump.commitSHAs) {
        this.getCommitSHAsForPathCache.load(dump.commitSHAs);
      }
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

  private getCommitSHAsForPathCache = new LRUCache<
    string,
    string[],
    GetCommitSHAsForPathOptions
  >({
    max: 1024,
    fetchMethod: async (_key, _staleValue, { context }) => {
      return await this.wrapped.getCommitSHAsForPath(context);
    },
  });

  // We mainly care about the state of the PR, a very dynamic value, so this cache is only
  // for avoiding repeated lookups within a single action run; we don't save it to the Actions cache.
  private getPullRequestCache = new LRUCache<
    string,
    PullRequest,
    GetPullRequestForNumberOptions
  >({
    max: 512,
    ttl: 1 * 60 * 1000, // 1 minute
    fetchMethod: async (_key, _staleValue, { context }) => {
      return await this.wrapped.getPullRequest(context);
    },
  });

  async resolveRefToSHA(options: ResolveRefToSHAOptions): Promise<string> {
    const sha = await this.resolveRefToSHACache.fetch(JSON.stringify(options), {
      context: options,
    });
    if (!sha) {
      throw Error(
        "resolveRefToSHACache.fetch should never resolve without a real SHA",
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
        "getTreeSHAForPathCache.fetch should never resolve without a boxed value",
      );
    }
    return cached.boxed;
  }

  async getCommitSHAsForPath(
    options: GetCommitSHAsForPathOptions,
  ): Promise<string[]> {
    const shas = await this.getCommitSHAsForPathCache.fetch(
      // Make it trivial to tell if a cache key corresponds to a SHA.
      (isSHA(options.ref) ? "SHA!" : "") + JSON.stringify(options),
      {
        context: options,
      },
    );
    if (!shas) {
      throw Error(
        "getCommitSHAsForPathCache.fetch should never resolve without a real SHA list",
      );
    }
    return shas;
  }

  dump(): CachingGitHubClientDump {
    // We don't dump resolveRefToSHACache because it is not immutable (it tracks
    // the current commits on main, etc).
    return {
      treeSHAs: this.getTreeSHAForPathCache.dump(),
      // While it's fine for us to cache the result of getCommitSHAsForPath
      // in-memory for mutable refs to reduce duplicate API calls within a
      // single execution, we only want to save the cache across executions for
      // the immutable case where the ref is a SHA.
      commitSHAs: this.getCommitSHAsForPathCache
        .dump()
        .filter(([key]) => key.startsWith("SHA!")),
    };
  }

  async getPullRequest(
    options: GetPullRequestForNumberOptions,
  ): Promise<PullRequest> {
    const pr = await this.getPullRequestCache.fetch(JSON.stringify(options), {
      context: options,
    });
    if (!pr) {
      throw Error(
        "getPullRequestCache.fetch should never resolve without a real PullRequest",
      );
    }
    return pr;
  }
}

export interface CachingGitHubClientDump {
  treeSHAs: [
    string,
    LRUCache.Entry<{
      boxed: string | null;
    }>,
  ][];
  commitSHAs?: [string, LRUCache.Entry<string[]>][];
}

export function isCachingGitHubClientDump(
  dump: unknown,
): dump is CachingGitHubClientDump {
  if (!dump || typeof dump !== "object") {
    return false;
  }
  if (!("treeSHAs" in dump)) {
    return false;
  }
  const { treeSHAs } = dump;
  if (!Array.isArray(treeSHAs)) {
    return false;
  }

  if ("commitSHAs" in dump) {
    const { commitSHAs } = dump;
    if (!Array.isArray(commitSHAs)) {
      return false;
    }
  }

  // XXX we could check the values further if we want to be more anal
  return true;
}

export async function getGitConfigRefPromotionInfo(options: {
  oldRef: string;
  newRef: string;
  repoURL: string;
  path: string;
  gitHubClient: GitHubClient;
  logger: PrefixingLogger;
}): Promise<PromotionInfo> {
  const { oldRef, newRef, repoURL, path, gitHubClient, logger } = options;

  // Figure out what commits affect the path in the new version.
  let newCommitSHAs;
  try {
    newCommitSHAs = await gitHubClient.getCommitSHAsForPath({
      repoURL,
      path,
      ref: newRef,
    });
  } catch (e) {
    logger.error(
      `Error loading commit SHAs for path ${repoURL}@${newRef} ${path}: ${e}`,
    );
    return promotionInfoUnknown(`Error loading commit SHAs for ${newRef}`);
  }

  // Figure out what commits affect the path previously. We're only going to
  // care about the most recent one and look for it in the list we got from the
  // last call. We don't just want to look for `ref` itself in the list for two
  // reasons: first, ref might not be a SHA, but more importantly, ref might not
  // itself be a commit corresponding to a change in `path`.
  let oldCommitSHAs;
  try {
    oldCommitSHAs = await gitHubClient.getCommitSHAsForPath({
      repoURL,
      path,
      ref: oldRef,
    });
  } catch (e) {
    logger.error(
      `Error loading commit SHAs for path ${repoURL}@${oldRef} ${path}: ${e}`,
    );
    return promotionInfoUnknown(`Error loading commit SHAs for ${oldRef}`);
  }

  if (oldCommitSHAs.length === 0) {
    return promotionInfoUnknown(`No commits found under ${path} at ${oldRef}.`);
  }
  const oldCommitSHAAtPath = oldCommitSHAs[oldCommitSHAs.length - 1];
  const oldIndexInNew = newCommitSHAs.indexOf(oldCommitSHAAtPath);
  if (oldIndexInNew === -1) {
    return promotionInfoUnknown(
      `Old commit ${oldCommitSHAAtPath} not found in recent history of ${newRef} at ${path}.`,
    );
  }
  if (oldIndexInNew + 1 === newCommitSHAs.length) {
    return { type: "no-commits" };
  }
  // Return the commits later than the old ones.
  return promotionInfoCommits(newCommitSHAs.slice(oldIndexInNew + 1));
}
