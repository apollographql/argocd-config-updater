import { faker } from '@faker-js/faker';
import { Tag, getTagsInRange } from '../src/artifactRegistry';

/**
 * Example tags from our registry:
 *
 * pr-15028---0013576-2024.04-gabcdefge979bd9243574e44a63a73b0f4e12ede56
 * main---0013572-2024.04-gabcdefg4d7f58193abc9e24a476133a771ca979c2
 *
 */
function makeMainTag(
  name: string,
  count: number,
  year: string,
  month: number,
): Tag {
  const gitHash = faker.git.commitSha();
  return makeTag(`main`, name, count, year, month, gitHash);
}

function makePRTag(
  prNumber: string,
  name: string,
  count: number,
  year: string,
  month: number,
): Tag {
  const gitHash = faker.git.commitSha();
  return makeTag(`pr-${prNumber}`, name, count, year, month, gitHash);
}

function makeTag(
  prefix: string,
  name: string,
  count: number,
  year: string,
  month: number,
  hash: string,
): Tag {
  const paddedCount = count.toString().padStart(7, '0');
  const paddedMonth = month.toString().padStart(2, '0');

  return {
    name,
    version: `${prefix}---${paddedCount}-${year}.${paddedMonth}-g${hash}`,
  };
}

const ENGINE_IDENTITY = 'engine-identity';

describe('ArtifactRegistry._getCommitsBetweenTags', () => {
  it('should return nothing when given an empty list', async () => {
    const prev = makeMainTag(ENGINE_IDENTITY, 1, '2024', 4);
    const next = makeMainTag(ENGINE_IDENTITY, 2, '2024', 4);
    expect(getTagsInRange(prev, next, [])).toStrictEqual([]);
  });

  it('should filter commits before prev (inclusive)', async () => {
    const prev = makeMainTag(ENGINE_IDENTITY, 5, '2024', 4);
    const next = makeMainTag(ENGINE_IDENTITY, 10, '2024', 4);
    const tags = [
      makeMainTag(ENGINE_IDENTITY, 4, '2024', 4),
      makeMainTag(ENGINE_IDENTITY, 3, '2024', 4),
      prev,
      makeMainTag(ENGINE_IDENTITY, 0, '2024', 4),
    ];
    expect(getTagsInRange(prev, next, tags)).toStrictEqual([]);
  });

  it('should filter commits after next (inclusive)', async () => {
    const prev = makeMainTag(ENGINE_IDENTITY, 5, '2024', 4);
    const next = makeMainTag(ENGINE_IDENTITY, 10, '2024', 4);
    const tags = [
      next,
      makeMainTag(ENGINE_IDENTITY, 11, '2024', 4),
      makeMainTag(ENGINE_IDENTITY, 12, '2024', 4),
      makeMainTag(ENGINE_IDENTITY, 100, '2024', 4),
    ];
    expect(getTagsInRange(prev, next, tags)).toStrictEqual([]);
  });

  it('should include commits between prev and next (in sorted order)', async () => {
    const prev = makeMainTag(ENGINE_IDENTITY, 5, '2024', 4);
    const next = makeMainTag(ENGINE_IDENTITY, 10, '2024', 4);
    const tags = [
      prev,
      next,
      makeMainTag(ENGINE_IDENTITY, 7, '2024', 4),
      makeMainTag(ENGINE_IDENTITY, 6, '2024', 4),
    ];
    expect(getTagsInRange(prev, next, tags)).toStrictEqual([tags[3], tags[2]]);
  });

  it('should return an empty list if left bound is not for `main---`', async () => {
    const prev = makePRTag('123', ENGINE_IDENTITY, 5, '2024', 4);
    const next = makeMainTag(ENGINE_IDENTITY, 10, '2024', 4);
    const tags = [
      prev,
      next,
      makeMainTag(ENGINE_IDENTITY, 7, '2024', 4),
      makeMainTag(ENGINE_IDENTITY, 6, '2024', 4),
    ];
    expect(getTagsInRange(prev, next, tags)).toStrictEqual([]);
  });

  it('should return an empty list if right bound is not for `main---`', async () => {
    const prev = makeMainTag(ENGINE_IDENTITY, 5, '2024', 4);
    const next = makePRTag('123', ENGINE_IDENTITY, 10, '2024', 4);
    const tags = [
      prev,
      next,
      makeMainTag(ENGINE_IDENTITY, 7, '2024', 4),
      makeMainTag(ENGINE_IDENTITY, 6, '2024', 4),
    ];
    expect(getTagsInRange(prev, next, tags)).toStrictEqual([]);
  });

  it('should ignore all tags without main--- prefix', async () => {
    const prev = makeMainTag(ENGINE_IDENTITY, 5, '2024', 4);
    const next = makeMainTag(ENGINE_IDENTITY, 10, '2024', 4);
    const tags = [
      prev,
      next,
      makePRTag('123', ENGINE_IDENTITY, 7, '2024', 4),
      makeMainTag(ENGINE_IDENTITY, 6, '2024', 4),
    ];
    expect(getTagsInRange(prev, next, tags)).toStrictEqual([tags[3]]);
  });
});
