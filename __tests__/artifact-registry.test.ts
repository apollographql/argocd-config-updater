import { faker } from '@faker-js/faker';
import { Tag, getCommitsBetweenTags } from '../src/artifactRegistry';

function makeTag(
  name: string,
  count: number,
  year: string,
  month: number,
): Tag {
  const paddedCount = count.toString().padStart(7, '0');
  const paddedMonth = month.toString().padStart(2, '0');

  const gitHash = faker.git.commitSha();
  return {
    name,
    version: `main---${paddedCount}-${year}.${paddedMonth}-${gitHash}`,
  };
}

describe('ArtifactRegistry._getCommitsBetweenTags', () => {
  it('should return nothing when given an empty list', async () => {
    const prev = makeTag('name', 1, '2024', 4);
    const next = makeTag('name', 2, '2024', 4);
    expect(getCommitsBetweenTags(prev, next, [])).toStrictEqual([]);
  });
});
