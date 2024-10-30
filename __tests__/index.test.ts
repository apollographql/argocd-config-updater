import { createTestPromotionMap } from './__fixtures__/promotionMap';
import { formatPromotedCommits } from '../src/index';

describe('formatPromotedCommits', () => {
  it('formats commits grouped by application', () => {
    const testMap = createTestPromotionMap();

    const result = formatPromotedCommits(testMap);

    const expectedOutput = `* teams/foundation/cron/application-values.yaml
  + Changes to Docker image \`engine-cron\` (and the Helm chart had a no-op change to match)
    * https://github.com/mdg-private/monorepo/commit/0da0318e6e27d20bb6c2765eddb040b7195039cb
    * https://github.com/mdg-private/monorepo/commit/6bef5749e1adf7a50f2f02288b5b3d7e67d9ed3b
* teams/foundation/cronpgsourcer/application-values.yaml
  + Changes to Docker image \`engine-cron\` (and the Helm chart had a no-op change to match)
    * https://github.com/mdg-private/monorepo/commit/0da0318e6e27d20bb6c2765eddb040b7195039cb
    * https://github.com/mdg-private/monorepo/commit/6bef5749e1adf7a50f2f02288b5b3d7e67d9ed3b
* teams/foundation/engine-graphql-schema-reporting/application-values.yaml
  + Changes to Docker image \`engine-graphql\` (and the Helm chart had a no-op change to match)
    * https://github.com/mdg-private/monorepo/commit/6bef5749e1adf7a50f2f02288b5b3d7e67d9ed3b
    * https://github.com/mdg-private/monorepo/commit/8cc7e192c861191d4404d57c7c126287e9485e7d
    * https://github.com/mdg-private/monorepo/commit/9886466ee2d5f08af96ad60bb5f4311e8b288af2
    * https://github.com/mdg-private/monorepo/commit/a5855887671789175d0b7683e62af4e336848d41
* teams/foundation/logmetrics2datadog/application-values.yaml
  + Changes to Docker image \`logmetrics2datadog\` (and the Helm chart had a no-op change to match)
    * https://github.com/mdg-private/monorepo/commit/6bef5749e1adf7a50f2f02288b5b3d7e67d9ed3b
* teams/foundation/persistedqueries/application-values.yaml
  + Changes to Docker image \`persistedqueries\` (and the Helm chart had a no-op change to match)
    * https://github.com/mdg-private/monorepo/commit/6bef5749e1adf7a50f2f02288b5b3d7e67d9ed3b
* teams/foundation/selfmonitoring/application-values.yaml
  + Changes to Docker image \`engine-self-monitoring\` (and the Helm chart had a no-op change to match)
    * https://github.com/mdg-private/monorepo/commit/6bef5749e1adf7a50f2f02288b5b3d7e67d9ed3b
`;
    expect(result).toEqual(expectedOutput);
  });
});
