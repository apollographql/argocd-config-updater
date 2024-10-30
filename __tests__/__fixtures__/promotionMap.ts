import {
  PromotionsByTargetEnvironment,
  EnvironmentPromotions,
} from '../../src/promotionInfo';

export const files = [
  'teams/foundation/cron/application-values.yaml',
  'teams/foundation/cronpgsourcer/application-values.yaml',
  'teams/foundation/engine-graphql-schema-reporting/application-values.yaml',
  'teams/foundation/logmetrics2datadog/application-values.yaml',
  'teams/foundation/persistedqueries/application-values.yaml',
  'teams/foundation/selfmonitoring/application-values.yaml',
];

export const dockerImages = [
  'engine-cron',
  'engine-cron',
  'engine-graphql',
  'logmetrics2datadog',
  'persistedqueries',
  'engine-self-monitoring',
];

export const commitGroups = [
  // engine-cron commits
  [
    '0da0318e6e27d20bb6c2765eddb040b7195039cb',
    '6bef5749e1adf7a50f2f02288b5b3d7e67d9ed3b',
  ],
  // engine-cron commits
  [
    '0da0318e6e27d20bb6c2765eddb040b7195039cb',
    '6bef5749e1adf7a50f2f02288b5b3d7e67d9ed3b',
  ],
  // engine-graphql commits
  [
    '6bef5749e1adf7a50f2f02288b5b3d7e67d9ed3b',
    '8cc7e192c861191d4404d57c7c126287e9485e7d',
    '9886466ee2d5f08af96ad60bb5f4311e8b288af2',
    'a5855887671789175d0b7683e62af4e336848d41',
  ],
  // logmetrics2datadog commits
  ['6bef5749e1adf7a50f2f02288b5b3d7e67d9ed3b'],
  // persistedqueries commits
  ['6bef5749e1adf7a50f2f02288b5b3d7e67d9ed3b'],
  // engine-self-monitoring commits
  ['6bef5749e1adf7a50f2f02288b5b3d7e67d9ed3b'],
];

export function createTestPromotionMap(): Map<
  string,
  PromotionsByTargetEnvironment
> {
  const testMap = new Map<string, PromotionsByTargetEnvironment>();

  for (const [index, file] of files.entries()) {
    const promotions = new Map<string, EnvironmentPromotions>();
    const envPromotions: EnvironmentPromotions = {
      trimmedRepoURL: 'https://github.com/mdg-private/monorepo',
      gitConfigPromotionInfo: {
        type: 'no-commits',
      },
      dockerImage: {
        repository: dockerImages[index],
        promotionInfo: {
          type: 'commits',
          commitSHAs: commitGroups[index],
        },
      },
      links: [],
    };
    promotions.set('prod', envPromotions);
    testMap.set(file, promotions);
  }
  return testMap;
}
