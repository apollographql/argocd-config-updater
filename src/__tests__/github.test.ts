// Tests for GitHub API utilities.

import { describe, it, expect } from "vitest";
import {
  callGitHub,
  resolveSymlinkTarget,
  getGitConfigRefPromotionInfo,
  GitHubClient,
} from "../github.js";
import { PrefixingLogger } from "../log.js";

describe("callGitHub", () => {
  it("passes through a successful result", async () => {
    await expect(callGitHub("doing a thing", async () => "ok")).resolves.toBe(
      "ok",
    );
  });

  it("wraps a thrown Error with GitHub context, preserving it as the cause", async () => {
    const original = new Error("Not Found");
    const call = callGitHub("fetching tag foo", async () => {
      throw original;
    });
    await expect(call).rejects.toThrow(
      "GitHub API error while fetching tag foo: Not Found",
    );
    await expect(call).rejects.toMatchObject({ cause: original });
  });

  it("wraps a non-Error throw as well", async () => {
    const call = callGitHub("fetching tag foo", async () => {
      // eslint-disable-next-line no-throw-literal -- testing non-Error throw
      throw "some string";
    });
    await expect(call).rejects.toThrow(
      "GitHub API error while fetching tag foo: some string",
    );
    await expect(call).rejects.toMatchObject({ cause: "some string" });
  });
});

describe("resolveSymlinkTarget", () => {
  it("resolves relative symlinks with ..", () => {
    expect(
      resolveSymlinkTarget("apps/linter/chart", "../../shared/chart"),
    ).toBe("shared/chart");
  });

  it("resolves relative symlinks within same directory", () => {
    expect(resolveSymlinkTarget("apps/linter/chart", "../common/chart")).toBe(
      "apps/common/chart",
    );
  });

  it("resolves relative symlinks to sibling", () => {
    // "apps/foo" -> "bar" means the symlink is in "apps/" and points to "apps/bar"
    expect(resolveSymlinkTarget("apps/foo", "bar")).toBe("apps/bar");
  });

  it("resolves relative symlinks in nested path", () => {
    expect(resolveSymlinkTarget("a/b/c/d", "../../x/y")).toBe("a/x/y");
  });

  it("throws for absolute symlink targets", () => {
    expect(() =>
      resolveSymlinkTarget("apps/linter/chart", "/shared/chart"),
    ).toThrow("absolute target");
  });

  it("handles . in path", () => {
    // "./bar" from "apps/foo" resolves to "apps/bar"
    expect(resolveSymlinkTarget("apps/foo", "./bar")).toBe("apps/bar");
  });

  it("throws when symlink escapes repository root", () => {
    expect(() => resolveSymlinkTarget("chart", "../other/chart")).toThrow(
      "escapes the repository root",
    );
  });

  it("throws when deeply nested symlink escapes repository root", () => {
    expect(() => resolveSymlinkTarget("a/b/c", "../../../../outside")).toThrow(
      "escapes the repository root",
    );
  });
});

describe("getGitConfigRefPromotionInfo", () => {
  const logger = PrefixingLogger.silent();

  it("returns symlink message when path is a symlink", async () => {
    const mockGitHubClient: GitHubClient = {
      async resolveRefToSHA() {
        return "abc123";
      },
      async getTreeSHAForPath() {
        return "tree-sha";
      },
      async getSymlinkTarget() {
        return "../shared/chart";
      },
      async getCommitSHAsForPath() {
        return [];
      },
      async getPullRequest() {
        return { state: "open", title: "Test PR", closedAt: null };
      },
    };

    const result = await getGitConfigRefPromotionInfo({
      oldRef: "old-ref",
      newRef: "new-ref",
      repoURL: "https://github.com/example/repo.git",
      path: "apps/linter/chart",
      gitHubClient: mockGitHubClient,
      logger,
    });

    expect(result.type).toBe("unknown");
    if (result.type === "unknown") {
      expect(result.message).toContain("is a symlink to");
      expect(result.message).toContain("apps/shared/chart");
      expect(result.message).toContain(
        "should be converted to regular directories",
      );
    }
  });

  it("proceeds normally when path is not a symlink", async () => {
    const mockGitHubClient: GitHubClient = {
      async resolveRefToSHA() {
        return "abc123";
      },
      async getTreeSHAForPath() {
        return "tree-sha";
      },
      async getSymlinkTarget() {
        return null;
      },
      async getCommitSHAsForPath() {
        return ["commit1"];
      },
      async getPullRequest() {
        return { state: "open", title: "Test PR", closedAt: null };
      },
    };

    const result = await getGitConfigRefPromotionInfo({
      oldRef: "old-ref",
      newRef: "new-ref",
      repoURL: "https://github.com/example/repo.git",
      path: "apps/linter/chart",
      gitHubClient: mockGitHubClient,
      logger,
    });

    // Should not return unknown/symlink message - normal processing occurred
    expect(result.type).toBe("no-commits");
  });
});
