import { readFile } from 'fs/promises';
import { join } from 'path';
import {
  DockerRegistryClient,
  GetAllEquivalentTagsOptions,
} from '../src/artifactRegistry';
import { updateDockerTags } from '../src/update-docker-tags';
import { PrefixingLogger } from '../src/log';

async function fixture(filename: string): Promise<string> {
  return await readFile(
    join(__dirname, '__fixtures__', 'update-docker-tags', filename),
    'utf-8',
  );
}

describe('action', () => {
  it('updates docker tags', async () => {
    const contents = await fixture('sample.yaml');
    const dockerRegistryClient: DockerRegistryClient = {
      async getAllEquivalentTags({ tag }: GetAllEquivalentTagsOptions) {
        return (
          {
            'from-mutable': [
              'from-mutable---000123-abcd',
              'another',
              'from-mutable',
            ],
            'from-something-random': [
              'bla---000123-abcd',
              'from-something-random---000123-abcd',
            ],
            'needs-update': ['needs-update---000200-dbca'],
            'can-stay-same': [
              'can-stay-same---0123-abcd',
              'can-stay-same---0124-bbcd',
            ],
            'should-roll-back-not-forward': [
              'should-roll-back-not-forward---000100-abcd',
              'should-roll-back-not-forward---000200-dcba',
            ],
          }[tag] ?? []
        );
      },
      async getGitCommitsBetweenTags() {
        return { type: 'no-commits' };
      },
    };
    const logger = PrefixingLogger.silent();
    const newContents = await updateDockerTags(
      contents,
      dockerRegistryClient,
      new Set<string>(),
      logger,
    );
    expect(newContents).toMatchSnapshot();

    // It should be idempotent in this case.
    expect(
      await updateDockerTags(
        newContents,
        dockerRegistryClient,
        new Set<string>(),
        logger,
      ),
    ).toBe(newContents);

    // Update the original one but with one service frozen.
    const frozenContents = await updateDockerTags(
      contents,
      dockerRegistryClient,
      new Set<string>(['some-service-dev2']),
      logger,
    );
    expect(frozenContents).toMatchSnapshot();
  });
});
