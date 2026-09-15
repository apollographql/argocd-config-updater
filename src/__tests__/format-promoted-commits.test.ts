// Tests for format-promoted-commits.ts
import { describe, it, expect } from "vitest";
import {
  assemblePRBody,
  formatPromotedCommits,
  MAX_PR_BODY_LENGTH,
  PR_BODY_TRUNCATION_NOTICE,
} from "../format-promoted-commits.js";
import { PRMetadata } from "../promotion-metadata-types.js";

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
