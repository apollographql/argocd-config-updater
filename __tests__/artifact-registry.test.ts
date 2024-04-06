import { faker } from '@faker-js/faker';
import { Tag, getTagsInRange } from '../src/artifactRegistry';

/**
 * Example tags from our registry:
 *
 * pr-15028---0013576-2024.04-gabcdefge979bd9243574e44a63a73b0f4e12ede56
 * main---0013572-2024.04-gabcdefg4d7f58193abc9e24a476133a771ca979c2
 *
 */
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
    version: `main---${paddedCount}-${year}.${paddedMonth}-g${gitHash}`,
  };
}

function makePRTag(
  prNumber: string,
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
    version: `pr-${prNumber}---${paddedCount}-${year}.${paddedMonth}-g${gitHash}`,
  };
}

const ENGINE_IDENTITY = 'engine-identity';

describe('ArtifactRegistry._getCommitsBetweenTags', () => {
  it('should return nothing when given an empty list', async () => {
    const prev = makeTag(ENGINE_IDENTITY, 1, '2024', 4);
    const next = makeTag(ENGINE_IDENTITY, 2, '2024', 4);
    expect(getTagsInRange(prev, next, [])).toStrictEqual([]);
  });

  it('should filter commits before prev (inclusive)', async () => {
    const prev = makeTag(ENGINE_IDENTITY, 5, '2024', 4);
    const next = makeTag(ENGINE_IDENTITY, 10, '2024', 4);
    const tags = [
      makeTag(ENGINE_IDENTITY, 4, '2024', 4),
      makeTag(ENGINE_IDENTITY, 3, '2024', 4),
      prev,
      makeTag(ENGINE_IDENTITY, 0, '2024', 4),
    ];
    expect(getTagsInRange(prev, next, tags)).toStrictEqual([]);
  });

  it('should filter commits after next (inclusive)', async () => {
    const prev = makeTag(ENGINE_IDENTITY, 5, '2024', 4);
    const next = makeTag(ENGINE_IDENTITY, 10, '2024', 4);
    const tags = [
      next,
      makeTag(ENGINE_IDENTITY, 11, '2024', 4),
      makeTag(ENGINE_IDENTITY, 12, '2024', 4),
      makeTag(ENGINE_IDENTITY, 100, '2024', 4),
    ];
    expect(getTagsInRange(prev, next, tags)).toStrictEqual([]);
  });

  it('should include commits between prev and next (in sorted order)', async () => {
    const prev = makeTag(ENGINE_IDENTITY, 5, '2024', 4);
    const next = makeTag(ENGINE_IDENTITY, 10, '2024', 4);
    const tags = [
      prev,
      next,
      makeTag(ENGINE_IDENTITY, 7, '2024', 4),
      makeTag(ENGINE_IDENTITY, 6, '2024', 4),
    ];
    expect(getTagsInRange(prev, next, tags)).toStrictEqual([tags[3], tags[2]]);
  });

  it('should return an empty list if left bound is not for `main---`', async () => {
    const prev = makePRTag('123', ENGINE_IDENTITY, 5, '2024', 4);
    const next = makeTag(ENGINE_IDENTITY, 10, '2024', 4);
    const tags = [
      prev,
      next,
      makeTag(ENGINE_IDENTITY, 7, '2024', 4),
      makeTag(ENGINE_IDENTITY, 6, '2024', 4),
    ];
    expect(getTagsInRange(prev, next, tags)).toStrictEqual([]);
  });

  it('should return an empty list if right bound is not for `main---`', async () => {
    const prev = makeTag(ENGINE_IDENTITY, 5, '2024', 4);
    const next = makePRTag('123', ENGINE_IDENTITY, 10, '2024', 4);
    const tags = [
      prev,
      next,
      makeTag(ENGINE_IDENTITY, 7, '2024', 4),
      makeTag(ENGINE_IDENTITY, 6, '2024', 4),
    ];
    expect(getTagsInRange(prev, next, tags)).toStrictEqual([]);
  });
});
