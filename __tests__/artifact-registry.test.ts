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

function makePRTag(
  count: number,
  year: string,
  month: number,
): [string, DockerTag] {
  const paddedCount = count.toString().padStart(7, '0');
  const paddedMonth = month.toString().padStart(2, '0');
  const shortHash = faker.git.shortSha();
  const hash = faker.git.commitSha();

  const prTag = `pr-123---${paddedCount}-${year}.${paddedMonth}-g${hash}`;
  const dockerTag = makeDockerTag(
    EXAMPLE_TAG_NAME_PATH,
    count,
    year,
    month,
    hash,
    shortHash,
  );
  return [prTag, dockerTag];
}

function makeMainTag(
  count: number,
  year: string,
  month: number,
): [string, DockerTag] {
  const paddedCount = count.toString().padStart(7, '0');
  const paddedMonth = month.toString().padStart(2, '0');
  const shortHash = faker.git.shortSha();
  const hash = faker.git.commitSha();

  const mainTag = `main---${paddedCount}-${year}.${paddedMonth}-g${hash}`;
  const dockerTag = makeDockerTag(
    EXAMPLE_TAG_NAME_PATH,
    count,
    year,
    month,
    hash,
    shortHash,
  );
  return [mainTag, dockerTag];
}

function getHash(dockerTag: DockerTag): string {
  const gitCommitMatches = dockerTag.version.match(/sha256:([0-9a-fA-F]+)$/);
  if (!gitCommitMatches) {
    throw new Error(`Could not find git commit in ${dockerTag.version}`);
  }
  return gitCommitMatches[1];
}

function getAllHashes(tags: DockerTag[]): string[] {
  return tags.map(getHash);
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
    name: `${namePathPrefix}/tags/${paddedCount}-${year}.${paddedMonth}-g${shortHash}`,
    version: `${namePathPrefix}/versions/sha256:${hash}`,
  };
}

/**
 * transforming the tag into the `main---count-year.month-ggitCommitHash` format
 */
function getTagFromDockerTagName(dockerTag: DockerTag): string {
  const gitCommitMatches = dockerTag.version.match(/sha256:([0-9a-fA-F]+)$/);
  if (!gitCommitMatches) {
    throw new Error(`Could not find git commit in ${dockerTag.version}`);
  }
  const nameTagData = dockerTag.name.split('/').pop() as string;
  const withoutHash = nameTagData.split('-').slice(0, 2).join('-');
  return `main---${withoutHash}-g${gitCommitMatches[1]}`;
}

const EXAMPLE_TAG_NAME_PATH =
  'projects/platform-cross-environment/locations/us-central1/repositories/platform-docker/packages/example';

describe('ArtifactRegistry.getRelevantCommits', () => {
  it('should return nothing when given an empty list', async () => {
    const [prev] = makeMainTag(1, '2024', 4);
    const [next] = makeMainTag(2, '2024', 4);
    expect(
      getRelevantCommits(prev, next, [], getTagFromDockerTagName),
    ).toStrictEqual([]);
  });

  it('should filter commits before prev (inclusive)', async () => {
    const [prev, prevDockerTag] = makeMainTag(5, '2024', 4);
    const [next] = makeMainTag(10, '2024', 4);
    const tags = [
      prevDockerTag,
      stubDockerTag(4, '2024', 4),
      stubDockerTag(3, '2024', 4),
      stubDockerTag(0, '2024', 4),
    ];
    expect(
      getRelevantCommits(prev, next, tags, getTagFromDockerTagName),
    ).toStrictEqual([]);
  });

  it('should filter commits after next (inclusive)', async () => {
    const [prev] = makeMainTag(5, '2024', 4);
    const [next, nextDockerTag] = makeMainTag(10, '2024', 4);
    const tags = [
      nextDockerTag,
      stubDockerTag(11, '2024', 4),
      stubDockerTag(12, '2024', 4),
      stubDockerTag(100, '2024', 4),
    ];
    expect(
      getRelevantCommits(prev, next, tags, getTagFromDockerTagName),
    ).toStrictEqual([]);
  });

  it('should include commits between prev and next (in sorted order)', async () => {
    const [prev, prevDockerTag] = makeMainTag(5, '2024', 4);
    const [next, nextDockerTag] = makeMainTag(10, '2024', 4);
    const tags = [
      prevDockerTag,
      nextDockerTag,
      stubDockerTag(7, '2024', 4),
      stubDockerTag(6, '2024', 4),
    ];

    const expected = getAllHashes([tags[3], tags[2]]);
    expect(
      getRelevantCommits(prev, next, tags, getTagFromDockerTagName),
    ).toStrictEqual(expected);
  });

  it('should return an empty list if left bound is not for `main---`', async () => {
    const [prev, prevDockerTag] = makePRTag(5, '2024', 4);
    const [next, nextDockerTag] = makeMainTag(10, '2024', 4);
    const tags = [
      prevDockerTag,
      nextDockerTag,
      stubDockerTag(7, '2024', 4),
      stubDockerTag(6, '2024', 4),
    ];
    expect(
      getRelevantCommits(prev, next, tags, getTagFromDockerTagName),
    ).toStrictEqual([]);
  });

  it('should return an empty list if right bound is not for `main---`', async () => {
    const [prev, prevDockerTag] = makeMainTag(5, '2024', 4);
    const [next, nextDockerTag] = makePRTag(10, '2024', 4);
    const tags = [
      prevDockerTag,
      nextDockerTag,
      stubDockerTag(7, '2024', 4),
      stubDockerTag(6, '2024', 4),
    ];
    expect(
      getRelevantCommits(prev, next, tags, getTagFromDockerTagName),
    ).toStrictEqual([]);
  });

  it('should dedup consecutive commit hashes', async () => {
    const [prev, prevDockerTag] = makeMainTag(5, '2024', 4);
    const [next, nextDockerTag] = makeMainTag(20, '2024', 4);
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
      EXAMPLE_TAG_NAME_PATH,
      7,
      '2024',
      4,
      hash1,
      shortHash1,
    );
    const otherCommit = stubDockerTag(8, '2024', 4);
    const commit2First = makeDockerTag(
      EXAMPLE_TAG_NAME_PATH,
      9,
      '2024',
      4,
      hash2,
      shortHash2,
    );
    const commit2Second = makeDockerTag(
      'main',
      10,
      '2024',
      4,
      hash2,
      shortHash2,
    );
    const commit1Third = makeDockerTag(
      EXAMPLE_TAG_NAME_PATH,
      11,
      '2024',
      4,
      hash1,
      shortHash1,
    );

    const tags = [
      prevDockerTag,
      nextDockerTag,
      commit1First,
      commit1Second,
      otherCommit,
      commit2First,
      commit2Second,
      commit1Third,
    ];

    console.log(getAllHashes(tags));

    // We expect consecutive duplicate commit hashes to be deduped
    // However if it returns later, this could imply a revert or rollback.
    // At the moment, we just keep that in, but later we should explicitly flag as a rollback.
    const expected = getAllHashes([tags[2], tags[4], tags[5], tags[7]]);
    expect(
      getRelevantCommits(prev, next, tags, getTagFromDockerTagName),
    ).toStrictEqual(expected);
  });
});
