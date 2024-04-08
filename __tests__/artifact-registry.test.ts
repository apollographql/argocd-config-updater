import { faker } from '@faker-js/faker';
import { DockerTag, getRelevantCommits } from '../src/artifactRegistry';

/**
 * Example tags from our registry:
 *
 * pr-15028---0013576-2024.04-gabcdefge979bd9243574e44a63a73b0f4e12ede56
 * main---0013572-2024.04-gabcdefg4d7f58193abc9e24a476133a771ca979c2
 *
 */

function stubDockerTag(count: number, year: string, month: number): DockerTag {
  const shortHash = faker.git.commitSha();
  const hash = faker.git.commitSha();
  return makeDockerTag(
    EXAMPLE_TAG_NAME_PATH,
    count,
    year,
    month,
    hash,
    shortHash,
  );
}

function makePRTag(count: number, year: string, month: number): string {
  const paddedCount = count.toString().padStart(7, '0');
  const paddedMonth = month.toString().padStart(2, '0');

  return `pr-123---${paddedCount}-${year}.${paddedMonth}-g${faker.git.commitSha()}`;
}

function makeMainTag(count: number, year: string, month: number): string {
  const paddedCount = count.toString().padStart(7, '0');
  const paddedMonth = month.toString().padStart(2, '0');

  return `main---${paddedCount}-${year}.${paddedMonth}-g${faker.git.commitSha()}`;
}

function makeDockerTag(
  namePathPrefix: string,
  count: number,
  year: string,
  month: number,
  hash: string,
  shortHash: string,
): DockerTag {
  const paddedCount = count.toString().padStart(7, '0');
  const paddedMonth = month.toString().padStart(2, '0');

  return {
    name: `${namePathPrefix}/tags/${year}.${paddedMonth}-${paddedCount}-g${shortHash}`,
    version: `${namePathPrefix}/versions/sha256:${hash}`,
  };
}

function getTagFromDockerTagName(dockerTagName: string): string {
  return dockerTagName.split('/').pop() as string;
}

const EXAMPLE_TAG_NAME_PATH =
  'projects/platform-cross-environment/locations/us-central1/repositories/platform-docker/packages/example';

describe('ArtifactRegistry.getRelevantCommits', () => {
  it('should return nothing when given an empty list', async () => {
    const prev = makeMainTag(1, '2024', 4);
    const next = makeMainTag(2, '2024', 4);
    expect(
      getRelevantCommits(prev, next, [], getTagFromDockerTagName),
    ).toStrictEqual([]);
  });

  it('should filter commits before prev (inclusive)', async () => {
    const prev = makeMainTag(5, '2024', 4);
    const next = makeMainTag(10, '2024', 4);
    const tags = [
      stubDockerTag(4, '2024', 4),
      stubDockerTag(5, '2024', 4),
      stubDockerTag(3, '2024', 4),
      stubDockerTag(0, '2024', 4),
    ];
    expect(
      getRelevantCommits(prev, next, tags, getTagFromDockerTagName),
    ).toStrictEqual([]);
  });

  it('should filter commits after next (inclusive)', async () => {
    const prev = makeMainTag(5, '2024', 4);
    const next = makeMainTag(10, '2024', 4);
    const tags = [
      stubDockerTag(10, '2024', 4),
      stubDockerTag(11, '2024', 4),
      stubDockerTag(12, '2024', 4),
      stubDockerTag(100, '2024', 4),
    ];
    expect(
      getRelevantCommits(prev, next, tags, getTagFromDockerTagName),
    ).toStrictEqual([]);
  });

  it('should include commits between prev and next (in sorted order)', async () => {
    const prev = makeMainTag(5, '2024', 4);
    const next = makeMainTag(10, '2024', 4);
    const tags = [
      stubDockerTag(5, '2024', 4),
      stubDockerTag(10, '2024', 4),
      stubDockerTag(7, '2024', 4),
      stubDockerTag(6, '2024', 4),
    ];
    expect(
      getRelevantCommits(prev, next, tags, getTagFromDockerTagName),
    ).toStrictEqual([tags[3], tags[2]]);
  });

  it('should return an empty list if left bound is not for `main---`', async () => {
    const prev = makePRTag(5, '2024', 4);
    const next = makeMainTag(10, '2024', 4);
    const tags = [
      stubDockerTag(5, '2024', 4),
      stubDockerTag(10, '2024', 4),
      stubDockerTag(7, '2024', 4),
      stubDockerTag(6, '2024', 4),
    ];
    expect(
      getRelevantCommits(prev, next, tags, getTagFromDockerTagName),
    ).toStrictEqual([]);
  });

  it('should return an empty list if right bound is not for `main---`', async () => {
    const prev = makeMainTag(5, '2024', 4);
    const next = makePRTag(10, '2024', 4);
    const tags = [
      stubDockerTag(5, '2024', 4),
      stubDockerTag(10, '2024', 4),
      stubDockerTag(7, '2024', 4),
      stubDockerTag(6, '2024', 4),
    ];
    expect(
      getRelevantCommits(prev, next, tags, getTagFromDockerTagName),
    ).toStrictEqual([]);
  });

  it('should dedup consecutive commit hashes', async () => {
    const prev = makeMainTag(5, '2024', 4);
    const next = makeMainTag(20, '2024', 4);
    const hash1 = faker.git.commitSha();
    const hash2 = faker.git.commitSha();
    const shortHash1 = faker.git.shortSha();
    const shortHash2 = faker.git.shortSha();
    const commit1First = makeDockerTag(
      EXAMPLE_TAG_NAME_PATH,
      6,
      '2024',
      4,
      hash1,
      shortHash1,
    );
    const commit1Second = makeDockerTag(
      'main',
      7,
      '2024',
      4,
      hash1,
      shortHash1,
    );
    const commit1Third = makeDockerTag(
      'main',
      11,
      '2024',
      4,
      hash1,
      shortHash1,
    );
    const commit2First = makeDockerTag('main', 9, '2024', 4, hash2, shortHash2);
    const commit2Second = makeDockerTag(
      'main',
      10,
      '2024',
      4,
      hash2,
      shortHash2,
    );

    const tags = [
      stubDockerTag(5, '2024', 4),
      stubDockerTag(20, '2024', 4),
      commit1First,
      commit1Second,
      stubDockerTag(8, '2024', 4),
      commit2First,
      commit2Second,
      commit1Third,
    ];

    // We expect consecutive duplicate commit hashes to be deduped
    // However if it returns later, this could imply a revert or rollback.
    // At the moment, we just keep that in, but later we should explicitly flag as a rollback.
    expect(
      getRelevantCommits(prev, next, tags, getTagFromDockerTagName),
    ).toStrictEqual([tags[2], tags[4], tags[5], tags[7]]);
  });
});
