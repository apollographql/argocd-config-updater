import { describe, it, expect } from "vitest";
import { setImmediate } from "timers/promises";
import { CachingDockerRegistryClient } from "../artifactRegistry.js";
import {
  CachingGitHubClient,
  CachingGitHubClientDump,
  GitHubClient,
} from "../github.js";

describe("CachingDockerRegistryClient caches", () => {
  it("getAllEquivalentTags caches", async () => {
    let call = 0;
    const client = new CachingDockerRegistryClient({
      async getDigestForTag(): Promise<string> {
        return "mock-digest";
      },
      async getAllEquivalentTags() {
        return [(++call).toString()];
      },
      async getGitCommitsBetweenTags() {
        return { type: "no-commits" };
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

    await exp("x", "y", "1");
    await exp("x", "y", "1");
    await exp("x", "z", "2");
    await exp("w", "y", "3");
    await exp("x", "y", "1");
  });
});

describe("CachingGitHubClient caches", () => {
  it("resolveRefToSHA caches", async () => {
    let call = 0;
    const client = new CachingGitHubClient({
      async resolveRefToSHA() {
        // Yield so that the parallel calls are parallel.
        await setImmediate();
        return (++call).toString();
      },
      async getTreeSHAForPath() {
        return "";
      },
      async getSymlinkTarget() {
        return null;
      },
      async getCommitSHAsForPath() {
        return [];
      },
      async isAncestor() {
        return true;
      },
      async getPullRequest() {
        return { state: "open", title: "Test PR", closedAt: null };
      },
    });

    async function exp(
      repoURL: string,
      ref: string,
      ret: string,
    ): Promise<void> {
      expect(await client.resolveRefToSHA({ repoURL, ref })).toBe(ret);
    }

    await exp("x", "y", "1");
    await exp("x", "y", "1");
    await exp("x", "z", "2");
    await exp("w", "y", "3");
    await exp("x", "y", "1");

    // Now try fetching two in parallel. We should only do one underlying fetch.
    const p1 = client.resolveRefToSHA({ repoURL: "a", ref: "b" });
    const p2 = client.resolveRefToSHA({ repoURL: "a", ref: "b" });
    expect(await p1).toBe("4");
    expect(await p2).toBe("4");
  });
  it("getTreeSHAForPath caches", async () => {
    let call = 0;
    const client = new CachingGitHubClient({
      async resolveRefToSHA() {
        return "";
      },
      async getTreeSHAForPath() {
        return (++call).toString();
      },
      async getSymlinkTarget() {
        return null;
      },
      async getCommitSHAsForPath() {
        return [];
      },
      async isAncestor() {
        return true;
      },
      async getPullRequest() {
        return { state: "open", title: "Test PR", closedAt: null };
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

    await exp("x", "y", "p", "1");
    await exp("x", "y", "p", "1");
    await exp("x", "z", "p", "2");
    await exp("w", "y", "p", "3");
    await exp("x", "y", "p", "1");
    await exp("x", "y", "pp", "4");
  });

  it("isAncestor uses transitivity to avoid calls", async () => {
    // History is a1 <- a2 <- m1 <- m2 <- m3, with `branch` forked off of a1.
    const order = ["a1", "a2", "m1", "m2", "m3"];
    const calls: string[] = [];
    const wrapped: GitHubClient = {
      async resolveRefToSHA() {
        return "";
      },
      async getTreeSHAForPath() {
        return "";
      },
      async getSymlinkTarget() {
        return null;
      },
      async getCommitSHAsForPath() {
        return [];
      },
      async isAncestor({ ancestorSHA, descendantSHA }) {
        calls.push(`${ancestorSHA}...${descendantSHA}`);
        const a = order.indexOf(ancestorSHA);
        const d = order.indexOf(descendantSHA);
        return a !== -1 && d !== -1 && a <= d;
      },
      async getPullRequest() {
        return { state: "open", title: "Test PR", closedAt: null };
      },
    };
    const repoURL = "https://github.com/example/repo.git";
    async function check(
      client: CachingGitHubClient,
      ancestorSHA: string,
      descendantSHA: string,
      expected: boolean,
      expectedNewCalls: string[],
      descendantRef = "main",
    ): Promise<void> {
      calls.length = 0;
      expect(
        await client.isAncestor({
          repoURL,
          ancestorSHA,
          descendantSHA,
          descendantRef,
        }),
      ).toBe(expected);
      expect(calls).toStrictEqual(expectedNewCalls);
    }

    const client = new CachingGitHubClient(wrapped);
    await check(client, "a1", "a1", true, []);
    await check(client, "a1", "m1", true, ["a1...m1"]);
    await check(client, "a2", "m1", true, ["a2...m1"]);
    await check(client, "a1", "m1", true, []);
    await check(client, "branch", "m1", false, ["branch...m1"]);

    // When the head moves from m1 to m2, we only need one call to learn that
    // everything that was in m1's history is still there.
    await check(client, "a1", "m2", true, ["m1...m2"]);
    await check(client, "a2", "m2", true, []);

    // The cache works across executions.
    const client2 = new CachingGitHubClient(
      wrapped,
      JSON.parse(JSON.stringify(client.dump())) as CachingGitHubClientDump,
    );
    await check(client2, "a1", "m2", true, []);
    await check(client2, "a1", "m3", true, ["m2...m3"]);
    await check(client2, "a2", "m3", true, []);

    // If the last known descendant isn't in the history of the new one (eg, a
    // force push), we fall back to checking directly.
    await check(client2, "a1", "branch", false, ["m3...branch", "a1...branch"]);
    await check(client2, "a1", "m3", true, []);

    // The same ancestor can be checked against two refs whose heads aren't
    // descendants of each other (here, `main` at m3 and `pr-1` at m1) without
    // them interfering with each other.
    await check(client2, "a1", "m1", true, ["a1...m1"], "pr-1");
    await check(client2, "a1", "m3", true, []);
    await check(client2, "a1", "m1", true, [], "pr-1");
    const client3 = new CachingGitHubClient(
      wrapped,
      JSON.parse(JSON.stringify(client2.dump())) as CachingGitHubClientDump,
    );
    await check(client3, "a1", "m3", true, []);
    await check(client3, "a1", "m1", true, [], "pr-1");
    await check(client3, "a1", "m2", true, ["m1...m2"], "pr-1");
    await check(client3, "a1", "m3", true, []);
  });
});
