import { describe, it, expect } from 'vitest';
import { faker } from '@faker-js/faker';
import { DockerTag, getRelevantCommits } from '../src/artifactRegistry';
import { promotionInfoCommits } from '../src/promotionInfo';

/**
 * Example tags from our registry:
 *
 * pr-15028---0013576-2024.04-gabcdefge979bd9243574e44a63a73b0f4e12ede56
 * main---0013572-2024.04-gabcdefg4d7f58193abc9e24a476133a771ca979c2
 *
 */

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

describe('ArtifactRegistry.getRelevantCommits', () => {
  it('should return null when "next" is not in tags', async () => {
    const prev = `main---0013572-2024.04-g${commitSha()}`;
    const next = `main---0013573-2024.04-g${commitSha()}`;
    expect(
      getRelevantCommits(prev, next, [{ tag: prev, version: 'x' }]),
    ).toMatchObject({
      type: 'unknown',
      message: expect.stringMatching(/New Docker tag.*unknown/),
    });
  });

  it('should return null when "prev" is not in tags', async () => {
    const prev = `main---0013572-2024.04-g${commitSha()}`;
    const next = `main---0013573-2024.04-g${commitSha()}`;
    expect(
      getRelevantCommits(prev, next, [{ tag: next, version: 'x' }]),
    ).toMatchObject({
      type: 'unknown',
      message: expect.stringMatching(/Old Docker tag.*unknown/),
    });
  });

  it('should return empty list when "prev" and "next" have same version', async () => {
    const prev = `main---0013572-2024.04-g${commitSha()}`;
    const next = `main---0013573-2024.04-g${commitSha()}`;
    expect(
      getRelevantCommits(prev, next, [
        { tag: prev, version: 'x' },
        { tag: next, version: 'x' },
      ]),
    ).toStrictEqual({ type: 'no-commits' });
  });

  it('should filter commits before prev (inclusive)', async () => {
    const tags = [
      {
        tag: `main---0000000-2024.04-g231d`,
        version: 'd',
      },
      {
        tag: `main---0000003-2024.04-gdebc`,
        version: 'c',
      },
      {
        tag: `main---0000004-2024.04-g4321`,
        version: 'b',
      },
      {
        tag: 'main---0000005-2024.04-g1234',
        version: 'a',
      },
      {
        tag: `main---0000006-2024.04-gdef1`,
        version: 'e',
      },
      { tag: 'main---0000010-2024.04-gabcd', version: 'e' },
    ];
    expect(
      getRelevantCommits(
        'main---0000005-2024.04-g1234',
        'main---0000010-2024.04-gabcd',
        tags,
      ),
    ).toStrictEqual(promotionInfoCommits(['def1']));
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
    expect(getRelevantCommits(prev, next, tags)).toStrictEqual(
      promotionInfoCommits([nextCommitSHA]),
    );
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

    expect(getRelevantCommits(prev, next, tags)).toStrictEqual(
      promotionInfoCommits(getAllHashes([tags[3], tags[2], nextDockerTag])),
    );
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
    expect(getRelevantCommits(prev, next, tags)).toMatchObject({
      type: 'unknown',
      message: expect.stringMatching(
        /Old Docker tag.*does not start with `main---`/,
      ),
    });
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
    expect(getRelevantCommits(prev, next, tags)).toMatchObject({
      type: 'unknown',
      message: expect.stringMatching(
        /New Docker tag.*does not start with `main---`/,
      ),
    });
  });

  it('should dedup consecutive versions', async () => {
    const prev = `main---0000005-2024.04-g${commitSha()}`;
    const next = `main---0000020-2024.04-g${commitSha()}`;
    const prevDockerTag: DockerTag = {
      tag: prev,
      version: 'a',
    };
    const nextDockerTag: DockerTag = {
      tag: next,
      version: 'e',
    };

    const commit1First = {
      tag: `main---0000006-2024.04-g${commitSha()}`,
      version: 'b',
    };

    const commit1Second = {
      tag: `main---0000007-2024.04-g${commitSha()}`,
      version: 'b',
    };

    const otherCommit = {
      tag: `main---0000008-2024.04-g${commitSha()}`,
      version: 'c',
    };

    const commit2First = {
      tag: `main---0000009-2024.04-g${commitSha()}`,
      version: 'd',
    };

    const commit2Second = {
      tag: `main---0000010-2024.04-g${commitSha()}`,
      version: 'd',
    };

    const commit1Third = {
      tag: `main---0000011-2024.04-g${commitSha()}`,
      version: 'b',
    };

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
    const expected = promotionInfoCommits(
      getAllHashes([tags[2], tags[4], tags[5], tags[7], tags[1]]),
    );
    expect(getRelevantCommits(prev, next, tags)).toStrictEqual(expected);
  });
});
