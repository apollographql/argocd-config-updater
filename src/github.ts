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

export interface IsAncestorOptions {
  repoURL: string;
  ancestorSHA: string;
  descendantSHA: string;
  // If `descendantSHA` is the current value of a mutable ref (eg, a branch),
  // the name of that ref. This does not affect the answer; it is only a hint
  // which lets a caching client avoid API calls, on the assumption that
  // successive values of one ref are usually descendants of each other.
  descendantRef?: string;
}

export interface GetPullRequestForNumberOptions {
  repoURL: string;
  prNumber: number;
}

export interface GetCommitInfoOptions {
  repoURL: string;
  // Usually a full commit SHA, but may be an abbreviated one (eg, one that
  // came from a Docker tag).
  commitSHA: string;
}

// Human-oriented information about a commit, used when describing promotions.
export interface CommitInfo {
  // The first line of the commit message.
  title: string;
  // The login of the GitHub user that GitHub associates with the commit's
  // author, if any. For apps, this ends with `[bot]`.
  authorLogin: string | null;
  // The author name recorded in the git commit itself.
  authorName: string | null;
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
  // Returns the symlink target if the path is a symlink, or null if it's not.
  getSymlinkTarget(options: GetTreeSHAForPathOptions): Promise<string | null>;
  getCommitSHAsForPath(options: GetCommitSHAsForPathOptions): Promise<string[]>;
  // Returns true if the commit `ancestorSHA` is reachable from the commit
  // `descendantSHA` (including if they are the same commit). Both must be
  // commit SHAs, not mutable refs.
  isAncestor(options: IsAncestorOptions): Promise<boolean>;
  getPullRequest(options: GetPullRequestForNumberOptions): Promise<PullRequest>;
  // Returns null if the commit can't be found in the repository.
  getCommitInfo(options: GetCommitInfoOptions): Promise<CommitInfo | null>;
}

export interface OwnerAndRepo {
  owner: string;
  repo: string;
}

export function parseRepoURL(repoURL: string): OwnerAndRepo {
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

function commitTitle(message: string): string {
  return message.split("\n", 1)[0].trim();
}

function isSHA(s: string): boolean {
  return !!s.match(/^[0-9a-f]{40}$/);
}

/**
 * Wraps a call to the GitHub (octokit) client so that any failure makes clear
 * it came from the GitHub API. Without this, errors like a 404 or a 502
 * surface as a bare `HttpError: Not Found`, which gives no hint that it came
 * from GitHub (as opposed to, say, Artifact Registry) or which request
 * failed.
 */
export async function callGitHub<T>(
  description: string,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (originalError) {
    const message =
      originalError instanceof Error
        ? originalError.message
        : String(originalError);
    throw new Error(`GitHub API error while ${description}: ${message}`, {
      cause: originalError,
    });
  }
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

  // Logs the call, then makes it, wrapping any failure so it's clear it came
  // from the GitHub API and which call failed.
  private async callAPI<T>(
    name: string,
    description: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    this.logger.info(`[GH API] ${name} ${description}`);
    this.apiCalls.set(name, (this.apiCalls.get(name) ?? 0) + 1);
    return callGitHub(`${name} ${description}`, fn);
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
      const rootTreeSHA = (
        await this.callAPI(
          "git.getCommit",
          `${owner} / ${repo} ${commitSHA}`,
          async () =>
            this.octokit.rest.git.getCommit({
              owner,
              repo,
              commit_sha: commitSHA,
            }),
        )
      ).data.tree.sha;
      const { tree, truncated } = (
        await this.callAPI(
          "git.getTree",
          `${owner} / ${repo} ${rootTreeSHA}`,
          async () =>
            this.octokit.rest.git.getTree({
              owner,
              repo,
              tree_sha: rootTreeSHA,
              recursive: "true",
            }),
        )
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
        const blobData = await this.callAPI(
          "git.getBlob",
          `${owner} / ${repo} ${sha}`,
          async () =>
            this.octokit.rest.git.getBlob({
              owner,
              repo,
              file_sha: sha,
            }),
        );
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
    const sha = (
      await this.callAPI(
        "repos.getCommit",
        `${owner}/${repo} ${refParameter}`,
        async () =>
          this.octokit.rest.repos.getCommit({
            owner,
            repo,
            ref: refParameter,
            mediaType: {
              format: "sha",
            },
          }),
      )
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

  async getSymlinkTarget({
    repoURL,
    commitSHA,
    path,
  }: GetTreeSHAForPathOptions): Promise<string | null> {
    const allTreesForCommit = await this.allTreesForCommitCache.fetch(
      JSON.stringify({ repoURL, commitSHA }),
      { context: { repoURL, commitSHA } },
    );
    if (!allTreesForCommit) {
      throw Error(`Unexpected missing entry in allTreesForCommitCache`);
    }
    return allTreesForCommit.pathToSymlinkTarget.get(path) ?? null;
  }

  // Fall back to asking the GitHub API for the tree hash directly if our cache
  // was truncated.
  private async getTreeSHAForPathViaGetContent({
    repoURL,
    commitSHA,
    path,
  }: GetTreeSHAForPathOptions): Promise<string | null> {
    const { owner, repo } = parseRepoURL(repoURL);
    const data = await this.callAPI(
      "repos.getContent",
      `${owner} / ${repo} ${commitSHA}`,
      async () => {
        try {
          return (
            // Octokit's response type for this call is a union of "file" |
            // "symlink" | "submodule" (directories come back as an array,
            // which we don't handle here) -- it doesn't include the "dir"
            // shape we check for below, even though the GitHub API can
            // actually return it for this media type. So we deliberately
            // erase the type here and re-narrow manually below with runtime
            // checks instead of trusting Octokit's type.
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
            (
              await this.octokit.rest.repos.getContent({
                owner,
                repo,
                ref: commitSHA,
                path,
                mediaType: {
                  format: "object",
                },
              })
            ).data as unknown
          );
        } catch (e: unknown) {
          // If it looks like "not found" just return null; anything else
          // propagates up through callAPI to get wrapped with context.
          if (typeof e === "object" && e && "status" in e && e.status === 404) {
            return null;
          }
          throw e;
        }
      },
    );
    if (data === null) {
      return null;
    }
    // See the comment above the `as unknown` cast for why we re-narrow this
    // by hand instead of trusting Octokit's type here.
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
    const { data } = await this.callAPI(
      "repos.listCommits",
      `${owner}/${repo}@${ref} ${path}`,
      async () =>
        this.octokit.rest.repos.listCommits({
          owner,
          repo,
          path,
          sha: ref,
          per_page: 100, // max allowed
        }),
    );
    // This response happens to contain everything that getCommitInfo needs to
    // know about these commits, so remember it in case we're asked.
    for (const { sha, commit, author } of data) {
      this.commitInfoFromListCommits.set(`${owner}/${repo}/${sha}`, {
        title: commitTitle(commit.message),
        authorLogin: author?.login ?? null,
        authorName: commit.author?.name ?? null,
      });
    }
    return data.map(({ sha }) => sha).reverse(); // Chronological order
  }

  // getCommitSHAsForPath (which we call to figure out which commits are in a
  // promotion) gets back from GitHub all the information that getCommitInfo
  // returns (which we call to describe those same commits), so we save it here
  // to avoid an API call per commit. This only helps within a single
  // execution; CachingGitHubClient is what remembers CommitInfos across
  // executions.
  private commitInfoFromListCommits = new LRUCache<string, CommitInfo>({
    max: 4096,
  });

  async getCommitInfo({
    repoURL,
    commitSHA,
  }: GetCommitInfoOptions): Promise<CommitInfo | null> {
    const { owner, repo } = parseRepoURL(repoURL);
    const fromListCommits = this.commitInfoFromListCommits.get(
      `${owner}/${repo}/${commitSHA}`,
    );
    if (fromListCommits) {
      return fromListCommits;
    }
    const data = await this.callAPI(
      "repos.getCommit",
      `${owner}/${repo} ${commitSHA} (commit info)`,
      async () => {
        try {
          return (
            await this.octokit.rest.repos.getCommit({
              owner,
              repo,
              ref: commitSHA,
              // The response includes the list of files changed by the commit
              // (with diffs!), which we don't care about; this asks for as
              // little of that as possible.
              per_page: 1,
            })
          ).data;
        } catch (e: unknown) {
          // 404 means there's no such commit; 422 is what you get for
          // something that doesn't resolve to a single commit (eg, an
          // ambiguous abbreviated SHA). Anything else propagates up through
          // callAPI to get wrapped with context.
          if (
            typeof e === "object" &&
            e &&
            "status" in e &&
            (e.status === 404 || e.status === 422)
          ) {
            return null;
          }
          throw e;
        }
      },
    );
    if (data === null) {
      return null;
    }
    return {
      title: commitTitle(data.commit.message),
      authorLogin: data.author?.login ?? null,
      authorName: data.commit.author?.name ?? null,
    };
  }

  async isAncestor({
    repoURL,
    ancestorSHA,
    descendantSHA,
  }: IsAncestorOptions): Promise<boolean> {
    if (ancestorSHA === descendantSHA) {
      return true;
    }
    const { owner, repo } = parseRepoURL(repoURL);
    const basehead = `${ancestorSHA}...${descendantSHA}`;
    const { status } = (
      await this.callAPI(
        "repos.compareCommitsWithBasehead",
        `${owner}/${repo} ${basehead}`,
        async () =>
          this.octokit.rest.repos.compareCommitsWithBasehead({
            owner,
            repo,
            basehead,
            // We only care about `status`, not the lists of commits and
            // files, so ask for as little of them as possible.
            per_page: 1,
          }),
      )
    ).data;
    // `status` describes the head (descendantSHA) relative to the base
    // (ancestorSHA): "ahead" means the head contains everything in the base
    // plus more, ie the base is an ancestor of the head. The other
    // possibilities are "behind" and "diverged".
    return status === "ahead" || status === "identical";
  }

  async getPullRequest({
    repoURL,
    prNumber,
  }: GetPullRequestForNumberOptions): Promise<PullRequest> {
    const { owner, repo } = parseRepoURL(repoURL);
    const response = await this.callAPI(
      "pulls.get",
      `${owner}/${repo} #${prNumber}`,
      async () =>
        this.octokit.rest.pulls.get({
          owner,
          repo,
          pull_number: prNumber,
        }),
    );
    return {
      state: response.data.state,
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
      // Support old cache files that don't have knownDescendants.
      if (dump.knownDescendants) {
        this.knownDescendantCache.load(dump.knownDescendants);
      }
      // Support old cache files that don't have commitInfos.
      if (dump.commitInfos) {
        this.getCommitInfoCache.load(dump.commitInfos);
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

  // isAncestor uses two caches which work together: `isAncestorCache` and
  // `knownDescendantCache`.
  //
  // The typical use of isAncestor is to ask "is the commit in this config file
  // still in the history of the branch it tracks?" for a lot of different
  // commits (one per tracked environment), and the head of that branch changes
  // frequently. We'd like the number of API calls we make to be proportional
  // to the number of times the branch moves, not to the number of
  // environments tracking it.
  //
  // `isAncestorCache` is a straightforward memoization of the wrapped
  // client's isAncestor: it maps an exact (repoURL, ancestorSHA,
  // descendantSHA) triple to true or false. It is only kept in memory for a
  // single execution.
  //
  // `knownDescendantCache` maps (the JSON-ification of) `{ repoURL,
  // ancestorSHA, descendantRef }` to the most recent value of the ref
  // `descendantRef` which we have confirmed that `ancestorSHA` is an ancestor
  // of. It never leads directly to an API call; instead, it lets us use
  // transitivity to turn a question we haven't asked before into one that we
  // probably have. It is saved across executions.
  //
  // For example, say `main` moves from M1 to M2, and 200 environments track
  // `main` with refs C1 through C200, each of which we have already confirmed
  // is an ancestor of M1 (so `knownDescendantCache` maps each (Cn, main) to
  // M1).
  //
  // - The first environment asks "is C1 an ancestor of M2?".
  //   `knownDescendantCache` tells us that C1 is an ancestor of M1, so it
  //   suffices to know "is M1 an ancestor of M2?". That goes through
  //   `isAncestorCache`, which makes one API call (and learns the answer is
  //   yes).
  // - The other 199 environments ask "is Cn an ancestor of M2?", which get
  //   converted in the same way into the identical question "is M1 an ancestor
  //   of M2?". `isAncestorCache` answers all of those without any API calls.
  // - Each (Cn, main) entry in `knownDescendantCache` is updated to M2, ready
  //   for the next time `main` moves.
  //
  // We need both caches to make this work with a single API call:
  //
  // - With only `knownDescendantCache`, each of the 200 environments would
  //   make its own API call to ask "is M1 an ancestor of M2?".
  // - With only `isAncestorCache` (even if we saved it across executions),
  //   none of the (Cn, M2) pairs have ever been seen before because M2 is new,
  //   so that's also 200 API calls.
  //
  // `isAncestorCache` is also the only place we remember a negative answer
  // (`knownDescendantCache` can only express "yes, it's an ancestor of this
  // commit"), and it shares one request between concurrent identical
  // questions.
  //
  // We don't save `isAncestorCache` across executions. It would be correct to
  // do so (its keys and values are facts about commit SHAs, which never
  // change), but nearly every pair in it involves whatever the head of the
  // branch was at the time, so it won't be asked about again once the branch
  // moves. The part of what it learned that stays useful is already recorded
  // in `knownDescendantCache`.
  //
  // We only remember one descendant per `knownDescendantCache` entry, which is
  // why the ref name is part of the key: the transitivity trick relies on each
  // entry following a single line of history. The same commit can be checked
  // against several refs. For example, one environment tracks `main` with ref
  // C, and another tracks `pr-123`, a PR which hasn't changed that
  // environment's path, so it has ref C too. The heads of `main` and `pr-123`
  // are generally not descendants of each other. If the two environments
  // shared an entry, each would overwrite the other's answer, and then find
  // that the remembered commit is no help for its own question: we'd make
  // several API calls for C on every execution even when neither ref has
  // moved.
  //
  // It is safe to save `knownDescendantCache` across executions because its
  // values are facts about commit SHAs, which never change. The ref name only
  // determines which entry we look at, and we always confirm that the
  // remembered commit is an ancestor of the one we're being asked about. So if
  // a ref is force-pushed (ie, its old head M1 is not an ancestor of its new
  // head M2), the "is M1 an ancestor of M2?" question is answered "no", and we
  // fall back to directly asking "is Cn an ancestor of M2?" for each
  // environment.
  private isAncestorCache = new LRUCache<
    string,
    // LRUCache can't store false, so we box it.
    { boxed: boolean },
    IsAncestorOptions
  >({
    max: 4096,
    fetchMethod: async (_key, _staleValue, { context }) => {
      return { boxed: await this.wrapped.isAncestor(context) };
    },
  });

  private knownDescendantCache = new LRUCache<string, string>({ max: 4096 });

  // Commits are immutable, so we save this across executions. (Technically the
  // GitHub user associated with a commit could change, eg if somebody adds the
  // commit's email address to their account later or renames their account,
  // but that's not worth re-fetching every commit for.)
  //
  // We do cache the fact that a commit could not be found (null) too. This
  // happens for every commit in the list of Docker image changes if an image
  // is built from a different repository than the one containing its Helm
  // chart, and we don't want to make a doomed API call for each of those
  // commits every time we regenerate a promotion PR's description.
  private getCommitInfoCache = new LRUCache<
    string,
    // LRUCache can't store null, so we box it.
    { boxed: CommitInfo | null },
    GetCommitInfoOptions
  >({
    max: 4096,
    fetchMethod: async (_key, _staleValue, { context }) => {
      return { boxed: await this.wrapped.getCommitInfo(context) };
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

  private async isAncestorViaCache(
    options: IsAncestorOptions,
  ): Promise<boolean> {
    const cached = await this.isAncestorCache.fetch(JSON.stringify(options), {
      context: options,
    });
    if (!cached) {
      throw Error(
        "isAncestorCache.fetch should never resolve without a boxed value",
      );
    }
    return cached.boxed;
  }

  async isAncestor(options: IsAncestorOptions): Promise<boolean> {
    const { repoURL, ancestorSHA, descendantSHA, descendantRef } = options;
    if (ancestorSHA === descendantSHA) {
      return true;
    }
    const knownDescendantKey = JSON.stringify({
      repoURL,
      ancestorSHA,
      descendantRef: descendantRef ?? null,
    });
    const knownDescendantSHA =
      this.knownDescendantCache.get(knownDescendantKey);
    const result =
      knownDescendantSHA === descendantSHA ||
      // See the comment on knownDescendantCache: this call is shared by
      // everything that was last checked against the same commit.
      (knownDescendantSHA !== undefined &&
        (await this.isAncestorViaCache({
          repoURL,
          ancestorSHA: knownDescendantSHA,
          descendantSHA,
        }))) ||
      // Either we've never checked this ancestor against this ref before, or
      // the commit we last checked it against isn't in the history of this
      // descendant (eg, a force push). Ask directly.
      (await this.isAncestorViaCache({ repoURL, ancestorSHA, descendantSHA }));
    if (result) {
      this.knownDescendantCache.set(knownDescendantKey, descendantSHA);
    }
    return result;
  }

  async getSymlinkTarget(
    options: GetTreeSHAForPathOptions,
  ): Promise<string | null> {
    // No caching for symlink targets - they're already cached in the wrapped
    // client's allTreesForCommitCache.
    return this.wrapped.getSymlinkTarget(options);
  }

  async getCommitInfo(
    options: GetCommitInfoOptions,
  ): Promise<CommitInfo | null> {
    const cached = await this.getCommitInfoCache.fetch(
      JSON.stringify(options),
      { context: options },
    );
    if (!cached) {
      throw Error(
        "getCommitInfoCache.fetch should never resolve without a boxed value",
      );
    }
    return cached.boxed;
  }

  dump(): CachingGitHubClientDump {
    // We don't dump resolveRefToSHACache because it is not immutable (it tracks
    // the current commits on main, etc).
    return {
      commitInfos: this.getCommitInfoCache.dump(),
      treeSHAs: this.getTreeSHAForPathCache.dump(),
      // While it's fine for us to cache the result of getCommitSHAsForPath
      // in-memory for mutable refs to reduce duplicate API calls within a
      // single execution, we only want to save the cache across executions for
      // the immutable case where the ref is a SHA.
      commitSHAs: this.getCommitSHAsForPathCache
        .dump()
        .filter(([key]) => key.startsWith("SHA!")),
      knownDescendants: this.knownDescendantCache.dump(),
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
  commitInfos?: [string, LRUCache.Entry<{ boxed: CommitInfo | null }>][];
  treeSHAs: [
    string,
    LRUCache.Entry<{
      boxed: string | null;
    }>,
  ][];
  commitSHAs?: [string, LRUCache.Entry<string[]>][];
  knownDescendants?: [string, LRUCache.Entry<string>][];
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

  if ("commitInfos" in dump) {
    const { commitInfos } = dump;
    if (!Array.isArray(commitInfos)) {
      return false;
    }
  }

  if ("commitSHAs" in dump) {
    const { commitSHAs } = dump;
    if (!Array.isArray(commitSHAs)) {
      return false;
    }
  }

  if ("knownDescendants" in dump) {
    const { knownDescendants } = dump;
    if (!Array.isArray(knownDescendants)) {
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

  // Check if the path is a symlink at the new ref. If so, we can't reliably
  // determine which commits affected it, so return a message encouraging the
  // user to convert the symlink to a real directory.
  let newRefCommitSHA;
  try {
    newRefCommitSHA = await gitHubClient.resolveRefToSHA({
      repoURL,
      ref: newRef,
    });
  } catch (e) {
    logger.error(`Error resolving ref ${newRef} in ${repoURL}: ${e}`);
    return promotionInfoUnknown(`Error resolving ref ${newRef}`);
  }
  const symlinkTarget = await gitHubClient.getSymlinkTarget({
    repoURL,
    commitSHA: newRefCommitSHA,
    path,
  });
  if (symlinkTarget) {
    const resolvedPath = resolveSymlinkTarget(path, symlinkTarget);
    return promotionInfoUnknown(
      `Path \`${path}\` is a symlink to \`${resolvedPath}\`. ` +
        `Symlinks are useful during migrations but should be converted to regular directories.`,
    );
  }

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
