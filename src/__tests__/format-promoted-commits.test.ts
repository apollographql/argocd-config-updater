// Tests for format-promoted-commits.ts
import { describe, it, expect } from 'vitest';
import { formatPromotedCommits } from '../format-promoted-commits.js';
import { PRMetadata } from '../promotion-metadata-types.js';

const sampleGitConfig = {
  repoURL: 'https://github.com/example/repo.git',
  path: 'services/my-app',
  ref: 'abc123',
};

describe('formatPromotedCommits', () => {
  it('includes prMetadata in output as HTML comment', () => {
    const promotions = new Map();
    const prMetadata: PRMetadata = {
      appPromotions: [
        {
          source: { appName: 'my-app-staging', gitConfig: sampleGitConfig },
          target: { appName: 'my-app-prod' },
        },
      ],
    };

    const result = formatPromotedCommits(promotions, prMetadata);

    expect(result).toMatchSnapshot();
  });

  it('validates prMetadata structure', () => {
    const promotions = new Map();
    const invalidMetadata = {
      appPromotions: [
        {
          source: { appName: 123 }, // Invalid: should be string
          target: { appName: 'my-app-prod' },
        },
      ],
    } as unknown as PRMetadata;

    expect(() => formatPromotedCommits(promotions, invalidMetadata)).toThrow();
  });

  it('handles empty appPromotions array', () => {
    const promotions = new Map();
    const prMetadata: PRMetadata = {
      appPromotions: [],
    };

    const result = formatPromotedCommits(promotions, prMetadata);

    expect(result).toMatchSnapshot();
  });

  it('handles multiple app promotions', () => {
    const promotions = new Map();
    const prMetadata: PRMetadata = {
      appPromotions: [
        {
          source: { appName: 'app1-staging', gitConfig: sampleGitConfig },
          target: { appName: 'app1-prod' },
        },
        {
          source: {
            appName: 'app2-dev',
            gitConfig: { ...sampleGitConfig, ref: 'def456' },
          },
          target: { appName: 'app2-staging' },
        },
      ],
    };

    const result = formatPromotedCommits(promotions, prMetadata);

    expect(result).toMatchSnapshot();
  });
});
