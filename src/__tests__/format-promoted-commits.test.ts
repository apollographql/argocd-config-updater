// Tests for format-promoted-commits.ts
import { describe, it, expect } from "vitest";
import { formatPromotedCommits } from "../format-promoted-commits.js";
import { PRMetadata } from "../promotion-metadata-types.js";
import { PromotionsByTargetEnvironment } from "../promotionInfo.js";

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

    const result = formatPromotedCommits(promotions, prMetadata);

    expect(result).toMatchSnapshot();
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

    const result = formatPromotedCommits(promotions, prMetadata);

    expect(result).toMatchSnapshot();
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

    const result = formatPromotedCommits(promotions, prMetadata);

    expect(result).toMatchSnapshot();
  });

  it("includes participants section from promotion commit authors", () => {
    const promotions = new Map<string, PromotionsByTargetEnvironment>();
    const envPromotions: PromotionsByTargetEnvironment = new Map();
    envPromotions.set("prod", {
      promotionSet: {
        trimmedRepoURL: "https://github.com/example/repo",
        gitConfigPromotionInfo: {
          type: "commits",
          commitSHAs: ["abc123", "def456"],
          authorLogins: ["alice", "bob"],
        },
        dockerImagePromotionInfo: null,
        links: [],
      },
      dockerImageRepository: null,
    });
    promotions.set("teams/myteam/myapp/application-values.yaml", envPromotions);

    const result = formatPromotedCommits(promotions, { appPromotions: [] });

    expect(result).toContain("**Participants:** @alice, @bob");
    expect(result).toMatchSnapshot();
  });

  it("omits participants section when no author logins are present", () => {
    const result = formatPromotedCommits(new Map(), { appPromotions: [] });

    expect(result).not.toContain("Participants");
  });
});
