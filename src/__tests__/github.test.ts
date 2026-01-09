// Tests for GitHub API utilities.

import { describe, it, expect } from "vitest";
import { resolveSymlinkTarget } from "../github.js";

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
