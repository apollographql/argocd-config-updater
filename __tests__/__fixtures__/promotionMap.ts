import {
  PromotionsByTargetEnvironment,
  EnvironmentPromotions,
} from '../../src/promotionInfo';

interface ApplicationTestData {
  file: string;
  dockerImage: string | null;
  commits: string[];
}

const applications: ApplicationTestData[] = [
  {
    file: 'app-a/service1/config.yaml',
    dockerImage: 'service-one',
    commits: [
      'aaa111222333444555666777888999000111222',
      'bbb111222333444555666777888999000111222',
    ],
  },
  {
    file: 'app-a/service2/config.yaml',
    dockerImage: 'service-two',
    commits: [
      'aaa111222333444555666777888999000111222',
      'bbb111222333444555666777888999000111222',
    ],
  },
  {
    file: 'app-b/api/config.yaml',
    dockerImage: 'api-service',
    commits: [
      'bbb111222333444555666777888999000111222',
      'ccc111222333444555666777888999000111222',
      'ddd111222333444555666777888999000111222',
      'eee111222333444555666777888999000111222',
    ],
  },
  {
    file: 'app-b/metrics/config.yaml',
    dockerImage: 'metrics-service',
    commits: ['bbb111222333444555666777888999000111222'],
  },
];
export function createTestPromotionMap(): Map<
  string,
  PromotionsByTargetEnvironment
> {
  const testMap = new Map<string, PromotionsByTargetEnvironment>();

  for (const app of applications) {
    const promotions: PromotionsByTargetEnvironment = new Map();

    const envPromotions: EnvironmentPromotions = {
      trimmedRepoURL: 'https://github.com/example/test-repo',
      gitConfigPromotionInfo: {
        type: 'no-commits',
      },
      dockerImage: app.dockerImage
        ? {
            repository: app.dockerImage,
            promotionInfo: {
              type: 'commits',
              commitSHAs: app.commits,
            },
          }
        : null,
      links: [],
    };

    promotions.set('prod', envPromotions);
    testMap.set(app.file, promotions);
  }

  return testMap;
}
