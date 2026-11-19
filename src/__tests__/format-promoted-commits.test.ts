// Tests for format-promoted-commits.ts
import { describe, it, expect } from "vitest";
import {
  assemblePRBody,
  collectPromotedCommits,
  formatPromotedCommit,
  formatPromotedCommits,
  lookUpCommitInfos,
  MAX_COMMIT_TITLE_LENGTH,
  MAX_PR_BODY_LENGTH,
  PR_BODY_TRUNCATION_NOTICE,
} from "../format-promoted-commits.js";
import { PRMetadata } from "../promotion-metadata-types.js";
import { PromotionsByTargetEnvironment } from "../promotionInfo.js";
import { CommitInfo, GitHubClient } from "../github.js";

const sampleGitConfig = {
  repoURL: "https://github.com/example/repo.git",
  path: "services/my-app",
  ref: "abc123",
};

describe("formatPromotedCommits", () => {
  it("includes prMetadata in output as HTML comment", () => {
    const promotions = new Map();
    const prMetadata: PRMetadata = {
      appPromotions: [
        {
          source: { appName: "my-app-staging", gitConfig: sampleGitConfig },
          target: { appName: "my-app-prod" },
        },
      ],
    };

    const { promotedCommitsMarkdown, truncated } = formatPromotedCommits(
      promotions,
      prMetadata,
    );

    expect(truncated).toBe(false);
    expect(promotedCommitsMarkdown).toMatchSnapshot();
  });

  it("validates prMetadata structure", () => {
    const promotions = new Map();
    const invalidMetadata = {
      appPromotions: [
        {
          source: { appName: 123 }, // Invalid: should be string
          target: { appName: "my-app-prod" },
        },
      ],
    } as unknown as PRMetadata;

    expect(() => formatPromotedCommits(promotions, invalidMetadata)).toThrow();
  });

  it("handles empty appPromotions array", () => {
    const promotions = new Map();
    const prMetadata: PRMetadata = {
      appPromotions: [],
    };

    const { promotedCommitsMarkdown, truncated } = formatPromotedCommits(
      promotions,
      prMetadata,
    );

    expect(truncated).toBe(false);
    expect(promotedCommitsMarkdown).toMatchSnapshot();
  });

  it("handles multiple app promotions", () => {
    const promotions = new Map();
    const prMetadata: PRMetadata = {
      appPromotions: [
        {
          source: { appName: "app1-staging", gitConfig: sampleGitConfig },
          target: { appName: "app1-prod" },
        },
        {
          source: {
            appName: "app2-dev",
            gitConfig: { ...sampleGitConfig, ref: "def456" },
          },
          target: { appName: "app2-staging" },
        },
      ],
    };

    const { promotedCommitsMarkdown, truncated } = formatPromotedCommits(
      promotions,
      prMetadata,
    );

    expect(truncated).toBe(false);
    expect(promotedCommitsMarkdown).toMatchSnapshot();
  });
});

describe("formatPromotedCommit", () => {
  const promotedCommit = {
    trimmedRepoURL: "https://github.com/example/repo",
    commitSHA: "abc123",
  };
  const url = "https://github.com/example/repo/commit/abc123";
  function format(commitInfo: Partial<CommitInfo> | null): string {
    return formatPromotedCommit(
      promotedCommit,
      commitInfo && {
        title: "Do a thing",
        authorLogin: "alice",
        authorName: "Alice A.",
        ...commitInfo,
      },
    );
  }

  it("is just the URL if we don't know anything about the commit", () => {
    expect(format(null)).toBe(url);
    expect(formatPromotedCommit(promotedCommit, undefined)).toBe(url);
  });

  it("mentions the author and links the title", () => {
    expect(format({})).toBe(`@alice [Do a thing](${url})`);
  });

  it("refers to the PR instead of showing the title, if the title names one", () => {
    expect(format({ title: "Do a thing (#1234)" })).toBe(
      `@alice example/repo#1234 ([commit](${url}))`,
    );
    // Only at the very end.
    expect(format({ title: "Revert (#12) for now" })).toBe(
      `@alice [Revert (#12) for now](${url})`,
    );
    // Only the last one.
    expect(format({ title: "Revert thing (#12) (#34)" })).toBe(
      `@alice example/repo#34 ([commit](${url}))`,
    );
    // Merge commits.
    expect(
      format({ title: "Merge pull request #6 from someone/patch-1" }),
    ).toBe(`@alice example/repo#6 ([commit](${url}))`);
    // Only GitHub's exact format.
    expect(format({ title: "Merge PR #6" })).toBe(
      `@alice [Merge PR #6](${url})`,
    );
    // Authors are handled the same way as when we show the title.
    expect(
      format({ title: "Update things (#5)", authorLogin: "renovate[bot]" }),
    ).toBe(`renovate\\[bot\\] example/repo#5 ([commit](${url}))`);
    expect(
      format({
        title: "Update things (#5)",
        authorLogin: null,
        authorName: null,
      }),
    ).toBe(`example/repo#5 ([commit](${url}))`);
  });

  it("doesn't mention bots", () => {
    expect(format({ authorLogin: "renovate[bot]" })).toBe(
      `renovate\\[bot\\] [Do a thing](${url})`,
    );
  });

  it("falls back to the git author name without mentioning anyone", () => {
    expect(format({ authorLogin: null })).toBe(`Alice A. [Do a thing](${url})`);
    expect(format({ authorLogin: null, authorName: "@bob [B]" })).toBe(
      `bob \\[B\\] [Do a thing](${url})`,
    );
    expect(format({ authorLogin: null, authorName: null })).toBe(
      `[Do a thing](${url})`,
    );
  });

  it("escapes Markdown in titles but leaves code spans alone", () => {
    expect(format({ title: "Fix [x] in `foo_bar[0]` and a_b <b> *c* `" })).toBe(
      `@alice [Fix \\[x\\] in \`foo_bar[0]\` and a\\_b \\<b\\> \\*c\\* \\\`](${url})`,
    );
  });

  it("truncates enormous titles", () => {
    const long = "x".repeat(MAX_COMMIT_TITLE_LENGTH);
    expect(format({ title: long })).toBe(`@alice [${long}](${url})`);
    expect(format({ title: `${long}yz` })).toBe(
      `@alice [${"x".repeat(MAX_COMMIT_TITLE_LENGTH - 1)}…](${url})`,
    );
  });

  it("uses the SHA as link text if the title is empty", () => {
    expect(format({ title: "" })).toBe(`@alice [abc123](${url})`);
  });
});

describe("formatPromotedCommits with commit info", () => {
  const promotions = new Map<string, PromotionsByTargetEnvironment>([
    [
      "teams/myteam/myapp/application-values.yaml",
      new Map([
        [
          "prod",
          {
            promotionSet: {
              trimmedRepoURL: "https://github.com/example/repo",
              gitConfigPromotionInfo: {
                type: "commits",
                commitSHAs: ["chart1", "both"],
              },
              dockerImagePromotionInfo: {
                type: "commits",
                commitSHAs: ["both", "image1", "mystery"],
              },
              links: [],
            },
            dockerImageRepository: "myapp",
          },
        ],
      ]),
    ],
  ]);

  it("collects each commit once", () => {
    expect(collectPromotedCommits(promotions)).toStrictEqual(
      ["chart1", "both", "image1", "mystery"].map((commitSHA) => ({
        trimmedRepoURL: "https://github.com/example/repo",
        commitSHA,
      })),
    );
  });

  it("describes commits in both lists", () => {
    const commitInfos: Record<string, CommitInfo> = {
      chart1: {
        title: "Change the chart directly",
        authorLogin: "alice",
        authorName: "Alice",
      },
      both: {
        title: "Change both (#2)",
        authorLogin: "bob",
        authorName: "Bob",
      },
      image1: {
        title: "chore(deps): update things (#3)",
        authorLogin: "renovate[bot]",
        authorName: "renovate[bot]",
      },
    };
    const { promotedCommitsMarkdown, promotedCommitsCommitMessage } =
      formatPromotedCommits(
        promotions,
        { appPromotions: [] },
        ({ commitSHA }) => commitInfos[commitSHA],
      );
    expect(promotedCommitsCommitMessage).toMatchInlineSnapshot(`
      "### Promoting to prod
      Apps:
      - teams/myteam/myapp

      Changes to Docker images:
      - https://github.com/example/repo/commit/both
      - https://github.com/example/repo/commit/image1
      - https://github.com/example/repo/commit/mystery

      Changes to Helm chart:
      - https://github.com/example/repo/commit/chart1
      - https://github.com/example/repo/commit/both

      "
    `);
    expect(promotedCommitsMarkdown).toMatchInlineSnapshot(`
      "<!-- prMetadata:eyJhcHBQcm9tb3Rpb25zIjpbXX0= -->

      ### Promoting to prod
      Apps:
      - teams/myteam/myapp

      Changes to Docker images:
      - @bob example/repo#2 ([commit](https://github.com/example/repo/commit/both))
      - renovate\\[bot\\] example/repo#3 ([commit](https://github.com/example/repo/commit/image1))
      - https://github.com/example/repo/commit/mystery

      Changes to Helm chart:
      - @alice [Change the chart directly](https://github.com/example/repo/commit/chart1)
      - @bob example/repo#2 ([commit](https://github.com/example/repo/commit/both))

      "
    `);
  });

  it("looks up each commit once and tolerates failures", async () => {
    const calls: string[] = [];
    const warnings: string[] = [];
    const gitHubClient = {
      async getCommitInfo({ repoURL, commitSHA }) {
        calls.push(`${repoURL} ${commitSHA}`);
        if (commitSHA === "mystery") {
          return null;
        }
        if (commitSHA === "image1") {
          throw Error("GitHub is sad");
        }
        return { title: commitSHA, authorLogin: "alice", authorName: null };
      },
    } as Partial<GitHubClient> as GitHubClient;
    const lookup = await lookUpCommitInfos(promotions, gitHubClient, 2, (m) =>
      warnings.push(m),
    );
    expect(calls.sort()).toStrictEqual(
      ["both", "chart1", "image1", "mystery"].map(
        (sha) => `https://github.com/example/repo ${sha}`,
      ),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("image1");
    const { promotedCommitsMarkdown } = formatPromotedCommits(
      promotions,
      { appPromotions: [] },
      lookup,
    );
    expect(promotedCommitsMarkdown).toContain(
      "Changes to Docker images:\n" +
        "- @alice [both](https://github.com/example/repo/commit/both)\n" +
        "- https://github.com/example/repo/commit/image1\n" +
        "- https://github.com/example/repo/commit/mystery\n",
    );
  });

  it("lists bare URLs if no lookup is provided", () => {
    const { promotedCommitsMarkdown, promotedCommitsCommitMessage } =
      formatPromotedCommits(promotions, {
        appPromotions: [],
      });
    // Other than the metadata comment, the two outputs are the same.
    expect(promotedCommitsMarkdown).toBe(
      `<!-- prMetadata:eyJhcHBQcm9tb3Rpb25zIjpbXX0= -->\n\n${promotedCommitsCommitMessage}`,
    );
    expect(promotedCommitsMarkdown).toContain(
      "Changes to Helm chart:\n- https://github.com/example/repo/commit/chart1\n- https://github.com/example/repo/commit/both\n",
    );
  });
});

describe("assemblePRBody", () => {
  const metadataComment =
    "<!-- prMetadata:eyJhcHBQcm9tb3Rpb25zIjpbXX0= -->\n\n";

  it("puts the metadata comment first and leaves short bodies untouched", () => {
    const body = "### Promoting to prod\nApps:\n- teams/x/app\n";
    const { promotedCommitsMarkdown, truncated } = assemblePRBody(
      metadataComment,
      body,
    );
    expect(truncated).toBe(false);
    expect(promotedCommitsMarkdown).toBe(`${metadataComment}${body}\n`);
    expect(promotedCommitsMarkdown).not.toContain(PR_BODY_TRUNCATION_NOTICE);
  });

  it("truncates an over-long body at a line boundary and appends the notice", () => {
    const line = "- https://github.com/example/repo/commit/0123456789abcdef\n";
    const lines = Math.ceil((MAX_PR_BODY_LENGTH * 2) / line.length);
    const body = line.repeat(lines);
    const { promotedCommitsMarkdown: result, truncated } = assemblePRBody(
      metadataComment,
      body,
    );

    expect(truncated).toBe(true);
    expect(result.length).toBeLessThanOrEqual(MAX_PR_BODY_LENGTH);
    expect(result.startsWith(metadataComment)).toBe(true);
    expect(result.endsWith(PR_BODY_TRUNCATION_NOTICE)).toBe(true);

    // Every surviving line must be a complete copy of the input line: nothing
    // half-written.
    const kept = result
      .slice(metadataComment.length, -PR_BODY_TRUNCATION_NOTICE.length)
      .split("\n");
    expect(kept.length).toBeGreaterThan(0);
    for (const keptLine of kept) {
      expect(`${keptLine}\n`).toBe(line);
    }
    // And we kept as much as we could: one more line would not have fit.
    expect(result.length + line.length).toBeGreaterThan(MAX_PR_BODY_LENGTH);
  });

  it("never drops the metadata comment even when nothing else fits", () => {
    const hugeMetadataComment = `<!-- prMetadata:${"A".repeat(MAX_PR_BODY_LENGTH)} -->\n\n`;
    const { promotedCommitsMarkdown, truncated } = assemblePRBody(
      hugeMetadataComment,
      "some body\n",
    );
    expect(truncated).toBe(true);
    expect(promotedCommitsMarkdown.startsWith(hugeMetadataComment)).toBe(true);
    expect(promotedCommitsMarkdown).toContain(PR_BODY_TRUNCATION_NOTICE);
    expect(promotedCommitsMarkdown).not.toContain("some body");
  });
});
