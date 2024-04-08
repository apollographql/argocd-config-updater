import { faker } from '@faker-js/faker';
import { DockerTag, getTagsInRange } from '../src/artifactRegistry';

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
): DockerTag {
  const gitHash = faker.git.commitSha();
  return makeTag(`main`, name, count, year, month, gitHash);
}

function makePRTag(
  prNumber: string,
  name: string,
  count: number,
  year: string,
  month: number,
): DockerTag {
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
): DockerTag {
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
    expect(getTagsInRange(prev.version, next.version, [])).toStrictEqual([]);
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
    expect(getTagsInRange(prev.version, next.version, tags)).toStrictEqual([]);
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
    expect(getTagsInRange(prev.version, next.version, tags)).toStrictEqual([]);
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
    expect(getTagsInRange(prev.version, next.version, tags)).toStrictEqual([
      tags[3],
      tags[2],
    ]);
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
    expect(getTagsInRange(prev.version, next.version, tags)).toStrictEqual([]);
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
    expect(getTagsInRange(prev.version, next.version, tags)).toStrictEqual([]);
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
    expect(getTagsInRange(prev.version, next.version, tags)).toStrictEqual([
      tags[3],
    ]);
  });

  it('should dedup consecutive commit hashes', async () => {
    const prev = makeMainTag(ENGINE_IDENTITY, 5, '2024', 4);
    const next = makeMainTag(ENGINE_IDENTITY, 20, '2024', 4);
    const commit1First = makeTag(
      'main',
      ENGINE_IDENTITY,
      6,
      '2024',
      4,
      'commit1hash',
    );
    const commit1Second = makeTag(
      'main',
      ENGINE_IDENTITY,
      7,
      '2024',
      4,
      'commit1hash',
    );
    const commit1Third = makeTag(
      'main',
      ENGINE_IDENTITY,
      11,
      '2024',
      4,
      'commit1hash',
    );
    const commit2First = makeTag(
      'main',
      ENGINE_IDENTITY,
      9,
      '2024',
      4,
      'commit2hash',
    );
    const commit2Second = makeTag(
      'main',
      ENGINE_IDENTITY,
      10,
      '2024',
      4,
      'commit2hash',
    );

    const tags = [
      prev,
      next,
      commit1First,
      commit1Second,
      makeMainTag(ENGINE_IDENTITY, 8, '2024', 4),
      commit2First,
      commit2Second,
      commit1Third,
    ];

    // We expect consecutive duplicate commit hashes to be deduped
    // However if it returns later, this could imply a revert or rollback.
    // At the moment, we just keep that in, but later we should explicitly flag as a rollback.
    expect(getTagsInRange(prev.version, next.version, tags)).toStrictEqual([
      tags[2],
      tags[4],
      tags[5],
      tags[7],
    ]);
  });
});

describe('ArtifactRegistry.getRelevantCommits', () => {
  it('should succeed', async () => {
    expect(true).toBe(true);
  });
});
