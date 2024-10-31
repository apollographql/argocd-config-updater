import { createTestPromotionMap } from './__fixtures__/promotionMap';
import { formatPromotedCommits } from '../src/index';

describe('formatPromotedCommits', () => {
  it('formats commits grouped by application', () => {
    const testMap = createTestPromotionMap();

    const result = formatPromotedCommits(testMap);

    const expectedOutput = `* app-a/service1/config.yaml
  + Changes to Docker image \`service-one\` (and the Helm chart had a no-op change to match)
    * https://github.com/example/test-repo/commit/aaa111222333444555666777888999000111222
    * https://github.com/example/test-repo/commit/bbb111222333444555666777888999000111222
* app-a/service2/config.yaml
  + Changes to Docker image \`service-two\` (and the Helm chart had a no-op change to match)
    * https://github.com/example/test-repo/commit/aaa111222333444555666777888999000111222
    * https://github.com/example/test-repo/commit/bbb111222333444555666777888999000111222
* app-b/api/config.yaml
  + Changes to Docker image \`api-service\` (and the Helm chart had a no-op change to match)
    * https://github.com/example/test-repo/commit/bbb111222333444555666777888999000111222
    * https://github.com/example/test-repo/commit/ccc111222333444555666777888999000111222
    * https://github.com/example/test-repo/commit/ddd111222333444555666777888999000111222
    * https://github.com/example/test-repo/commit/eee111222333444555666777888999000111222
* app-b/metrics/config.yaml
  + Changes to Docker image \`metrics-service\` (and the Helm chart had a no-op change to match)
    * https://github.com/example/test-repo/commit/bbb111222333444555666777888999000111222
`;
    expect(result).toEqual(expectedOutput);
  });
});
