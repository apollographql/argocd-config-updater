import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The action's script, run against a throwaway git repository. The tags it
// produces must satisfy the parsing in artifactRegistry.ts: an immutable tag
// starts with `<mutable>---`, main's sort in commit order, and `-g<sha>`
// names the commit.
const script = join(
  __dirname,
  "../../compute-image-tags/compute-image-tags.sh",
);

let repo: string;

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

function commit(message: string, date = "2026-11-11T12:00:00Z"): string {
  writeFileSync(join(repo, message), message);
  git("add", ".");
  execFileSync("git", ["commit", "-q", "-m", message], {
    cwd: repo,
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
  return git("rev-parse", "HEAD");
}

function run(env: Record<string, string>): Record<string, string> {
  const out = execFileSync(script, {
    cwd: repo,
    encoding: "utf8",
    env: { PATH: process.env.PATH, ...env },
  });
  return Object.fromEntries(
    out
      .trim()
      .split("\n")
      .map((line) => line.split(/=(.*)/s).slice(0, 2)),
  );
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "compute-image-tags-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  commit("one");
  commit("two");
  // Committed late on the last day of a month in a western timezone, so the
  // month is only 2026.04 if it is read in UTC.
  commit("three", "2026-03-31T23:30:00-05:00");
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("compute-image-tags", () => {
  it("tags a push to the default branch with its name", () => {
    const head = git("rev-parse", "HEAD");
    const outputs = run({
      EVENT_NAME: "push",
      REF_NAME: "main",
      DEFAULT_BRANCH: "main",
      RUN_NUMBER: "42",
      RUN_ATTEMPT: "1",
    });
    expect(outputs.mutable).toBe("main");
    expect(outputs.immutable).toBe(
      `main---0000003-2026.04.b0000042.01-g${head}`,
    );
    expect(outputs.publish).toBe("true");
    expect(outputs.tree).toBe(git("rev-parse", "HEAD^{tree}"));
    expect(outputs.immutable.match(/-g([0-9a-fA-F]+)$/)?.[1]).toBe(head);
  });

  it("tags a pull request as pr-N, naming the given commit", () => {
    // A pull_request checkout is a merge commit; the tag names the PR's head
    // and takes its month from that commit, not from HEAD.
    const prHead = git("rev-parse", "HEAD~1");
    const outputs = run({
      EVENT_NAME: "pull_request",
      REF_NAME: "17/merge",
      DEFAULT_BRANCH: "main",
      PR_NUMBER: "17",
      COMMIT: prHead,
      RUN_NUMBER: "7",
      RUN_ATTEMPT: "3",
    });
    expect(outputs.mutable).toBe("pr-17");
    expect(outputs.immutable).toBe(
      `pr-17---0000003-2026.11.b0000007.03-g${prHead}`,
    );
    expect(outputs.publish).toBe("true");
  });

  it("sorts main tags in commit order before run order", () => {
    const earlier = run({
      EVENT_NAME: "push",
      REF_NAME: "main",
      DEFAULT_BRANCH: "main",
      RUN_NUMBER: "9999999",
      RUN_ATTEMPT: "99",
    }).immutable;
    commit("four");
    const later = run({
      EVENT_NAME: "push",
      REF_NAME: "main",
      DEFAULT_BRANCH: "main",
      RUN_NUMBER: "1",
      RUN_ATTEMPT: "1",
    }).immutable;
    expect(earlier.localeCompare(later)).toBeLessThan(0);
  });

  it("gives a re-run its own tag", () => {
    const env = {
      EVENT_NAME: "push",
      REF_NAME: "main",
      DEFAULT_BRANCH: "main",
    };
    const first = run({ ...env, RUN_NUMBER: "5", RUN_ATTEMPT: "1" }).immutable;
    const rerun = run({ ...env, RUN_NUMBER: "5", RUN_ATTEMPT: "2" }).immutable;
    expect(rerun).not.toBe(first);
    expect(first.localeCompare(rerun)).toBeLessThan(0);
  });

  it("does not publish from other branches or merge queues", () => {
    for (const env of [
      { EVENT_NAME: "push", REF_NAME: "feature", DEFAULT_BRANCH: "main" },
      {
        EVENT_NAME: "merge_group",
        REF_NAME: "gh-readonly-queue/main/pr-3",
        DEFAULT_BRANCH: "main",
      },
    ]) {
      const outputs = run({ ...env, RUN_NUMBER: "1", RUN_ATTEMPT: "1" });
      expect(outputs.mutable).toBe("");
      expect(outputs.immutable).toBe("");
      expect(outputs.publish).toBe("false");
      expect(outputs.tree).toBe(git("rev-parse", "HEAD^{tree}"));
    }
  });

  it("refuses a shallow checkout", () => {
    const shallow = mkdtempSync(join(tmpdir(), "compute-image-tags-shallow-"));
    try {
      // A plain local path would be hardlinked at full depth; file:// honours --depth.
      execFileSync("git", [
        "clone",
        "-q",
        "--depth",
        "1",
        `file://${repo}`,
        shallow,
      ]);
      expect(() =>
        execFileSync(script, {
          cwd: shallow,
          encoding: "utf8",
          stdio: "pipe",
          env: {
            PATH: process.env.PATH,
            EVENT_NAME: "push",
            REF_NAME: "main",
            DEFAULT_BRANCH: "main",
            RUN_NUMBER: "1",
            RUN_ATTEMPT: "1",
          },
        }),
      ).toThrow(/shallow/);
    } finally {
      rmSync(shallow, { recursive: true, force: true });
    }
  });
});
