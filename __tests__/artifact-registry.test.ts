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
  return makeDockerTag(count, year, month, hash, shortHash);
}

function makePRTag(
  count: number,
  year: string,
  month: number,
): [string, DockerTag] {
  const paddedCount = count.toString().padStart(7, '0');
  const paddedMonth = month.toString().padStart(2, '0');
  const shortHash = faker.git.commitSha({ length: 7 });
  const hash = faker.git.commitSha();

  const prTag = `pr-123---${paddedCount}-${year}.${paddedMonth}-g${hash}`;
  const dockerTag = makeDockerTag(count, year, month, hash, shortHash);
  return [prTag, dockerTag];
}

function makeMainTag(
  count: number,
  year: string,
  month: number,
): [string, DockerTag] {
  const paddedCount = count.toString().padStart(7, '0');
  const paddedMonth = month.toString().padStart(2, '0');
  const shortHash = faker.git.commitSha({ length: 7 });
  const hash = faker.git.commitSha();

  const mainTag = `main---${paddedCount}-${year}.${paddedMonth}-g${hash}`;
  const dockerTag = makeDockerTag(count, year, month, hash, shortHash);
  return [mainTag, dockerTag];
}

function getHash(dockerTag: DockerTag): string {
  const gitCommitMatches = dockerTag.tag.match(/-g([0-9a-fA-F]+)$/);
  if (!gitCommitMatches) {
    throw new Error(`Could not find git commit in ${dockerTag.tag}`);
  }
  return gitCommitMatches[1];
}

function getAllHashes(tags: DockerTag[]): string[] {
  return tags.map(getHash);
}

function commitSha(): string {
  return faker.git.commitSha();
}

function makeDockerTag(
  count: number,
  year: string,
  month: number,
  hash: string,
  shortHash: string,
): DockerTag {
  const paddedCount = count.toString().padStart(7, '0');
  const paddedMonth = month.toString().padStart(2, '0');

  return {
    tag: `main---${paddedCount}-${year}.${paddedMonth}-g${shortHash}`,
    version: `some/path/versions/sha256:${hash}`,
  };
}

/**
 * transforming the tag into the `main---count-year.month-ggitCommitHash` format
 */
// function getTagFromDockerTagName(dockerTag: DockerTag): string {
//   const gitCommitMatches = dockerTag.version.match(/sha256:([0-9a-fA-F]+)$/);
//   if (!gitCommitMatches) {
//     throw new Error(`Could not find git commit in ${dockerTag.version}`);
//   }
//   const nameTagData = dockerTag.tag.split('/').pop() as string;
//   const withoutHash = nameTagData.split('-').slice(0, 2).join('-');
//   return `main---${withoutHash}-g${gitCommitMatches[1]}`;
// }

describe('ArtifactRegistry.getRelevantCommits', () => {
  it('should return nothing when given an empty list', async () => {
    const [prev] = `main---0013572-2024.04-g${commitSha()}`;
    const [next] = `main---0013573-2024.04-g${commitSha()}`;
    expect(getRelevantCommits(prev, next, [])).toStrictEqual([]);
  });

  it('should filter commits before prev (inclusive)', async () => {
    const prev = `main---0000005-2024.04-g${commitSha()}`;
    const next = `main---0000010-2024.04-g${commitSha()}`;
    const prevDockerTag: DockerTag = {
      tag: prev,
      version: 'a',
    };
    const afterDockerTagCommit = commitSha();
    const afterDockerTag: DockerTag = {
      tag: `main---0000006-2024.04-g${afterDockerTagCommit}`,
      version: 'e',
    };

    const tags = [
      prevDockerTag,
      {
        tag: `main---0000004-2024.04-g${commitSha()}`,
        version: 'b',
      },
      {
        tag: `main---0000003-2024.04-g${commitSha()}`,
        version: 'c',
      },
      {
        tag: `main---0000000-2024.04-g${commitSha()}`,
        version: 'd',
      },
      afterDockerTag,
    ];
    expect(getRelevantCommits(prev, next, tags)).toStrictEqual([
      afterDockerTagCommit,
    ]);
  });

  it('should filter commits after next (exclusive)', async () => {
    const prev = `main---0000005-2024.04-g${commitSha()}`;
    const nextCommitSHA = commitSha();
    const next = `main---0000010-2024.04-g${nextCommitSHA}`;
    const prevDockerTag: DockerTag = {
      tag: prev,
      version: 'a',
    };
    const nextDockerTag: DockerTag = {
      tag: next,
      version: 'e',
    };
    const tags = [
      prevDockerTag,
      nextDockerTag,
      {
        tag: `main---0000011-2024.04-g${commitSha()}`,
        version: 'b',
      },
      {
        tag: `main---0000012-2024.04-g${commitSha()}`,
        version: 'c',
      },
      {
        tag: `main---0000100-2024.04-g${commitSha()}`,
        version: 'd',
      },
    ];
    expect(getRelevantCommits(prev, next, tags)).toStrictEqual([nextCommitSHA]);
  });

  it('should include commits between prev and next (in sorted order) -- next is inclusive', async () => {
    const prev = `main---0000005-2024.04-g${commitSha()}`;
    const nextCommitSHA = commitSha();
    const next = `main---0000010-2024.04-g${nextCommitSHA}`;
    const prevDockerTag: DockerTag = {
      tag: prev,
      version: 'a',
    };
    const nextDockerTag: DockerTag = {
      tag: next,
      version: 'e',
    };
    const tags = [
      prevDockerTag,
      nextDockerTag,
      {
        tag: `main---0000007-2024.04-g${commitSha()}`,
        version: 'b',
      },
      {
        tag: `main---0000006-2024.04-g${commitSha()}`,
        version: 'c',
      },
    ];

    const expected = getAllHashes([tags[3], tags[2], nextDockerTag]);
    expect(getRelevantCommits(prev, next, tags)).toStrictEqual(expected);
  });

  it('should return an empty list if left bound is not for `main---`', async () => {
    const prev = `pr-123---0000005-2024.04-g${commitSha()}`;
    const next = `main---0000010-2024.04-g${commitSha()}`;
    const prevDockerTag: DockerTag = {
      tag: prev,
      version: 'a',
    };
    const nextDockerTag: DockerTag = {
      tag: next,
      version: 'e',
    };
    const tags = [
      prevDockerTag,
      nextDockerTag,
      {
        tag: `main---0000007-2024.04-g${commitSha()}`,
        version: 'b',
      },
      {
        tag: `main---0000006-2024.04-g${commitSha()}`,
        version: 'c',
      },
    ];
    expect(getRelevantCommits(prev, next, tags)).toStrictEqual([]);
  });

  it('should return an empty list if right bound is not for `main---`', async () => {
    const prev = `main---0000005-2024.04-g${commitSha()}`;
    const next = `pr-123---0000010-2024.04-g${commitSha()}`;
    const prevDockerTag: DockerTag = {
      tag: prev,
      version: 'a',
    };
    const nextDockerTag: DockerTag = {
      tag: next,
      version: 'e',
    };
    const tags = [
      prevDockerTag,
      nextDockerTag,
      {
        tag: `main---0000007-2024.04-g${commitSha()}`,
        version: 'b',
      },
      {
        tag: `main---0000006-2024.04-g${commitSha()}`,
        version: 'c',
      },
    ];
    expect(getRelevantCommits(prev, next, tags)).toStrictEqual([]);
  });

  it('should dedup consecutive commit hashes', async () => {
    const [prev, prevDockerTag] = makeMainTag(5, '2024', 4);
    const [next, nextDockerTag] = makeMainTag(20, '2024', 4);
    const hash1 = faker.git.commitSha();
    const hash2 = faker.git.commitSha();
    const shortHash1 = faker.git.commitSha({ length: 7 });
    const shortHash2 = faker.git.commitSha({ length: 7 });
    const commit1First = makeDockerTag(6, '2024', 4, hash1, shortHash1);
    const commit1Second = makeDockerTag(7, '2024', 4, hash1, shortHash1);
    const otherCommit = stubDockerTag(8, '2024', 4);
    const commit2First = makeDockerTag(9, '2024', 4, hash2, shortHash2);
    const commit2Second = makeDockerTag(10, '2024', 4, hash2, shortHash2);
    const commit1Third = makeDockerTag(11, '2024', 4, hash1, shortHash1);

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

    // We expect consecutive duplicate commit hashes to be deduped
    // However if it returns later, this could imply a revert or rollback.
    // At the moment, we just keep that in, but later we should explicitly flag as a rollback.
    const expected = getAllHashes([
      tags[2],
      tags[4],
      tags[5],
      tags[7],
      tags[1],
    ]);
    expect(getRelevantCommits(prev, next, tags)).toStrictEqual(expected);
  });
});
