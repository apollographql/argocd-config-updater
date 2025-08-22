import { readFile } from 'fs/promises';
import { join } from 'path';
import { updateGraphArtifactRefs } from '../src/update-graph-artifact-refs';
import { PrefixingLogger } from '../src/log';
import {
  DockerRegistryClient,
  GetDigestForTagOptions,
} from '../src/artifactRegistry';

async function fixture(filename: string): Promise<string> {
  return await readFile(
    join(
      __dirname,
      '__fixtures__',
      'update-promoted-graph-artifacts',
      filename,
    ),
    'utf-8',
  );
}

const logger = PrefixingLogger.silent();
const imageTagMap: { [imageName: string]: { [tag: string]: string } } = {
  'some-service': {
    dev0: 'sha256:90ee9ef20ce29314b29ccbbf4c50c1a881e35fdba7f53445cc083247bba9a6fb',
    dev1: 'sha256:ecb1de1af081bbad2e770d3db8dde4fc4b4eca6ab3e6950f8f2d833f1690b280',
    staging:
      'sha256:81b06e1d3cafc6d2e29d9ed9f6b1ee6a7b09914ff9fe2c0fded6dc00e337566d',
    prod: 'sha256:23241438abb41ee697d51878a5f2d29bf5824496e7aeb8649c8d826541160a4b',
    another:
      'sha256:ffc964f26300b5fb3fe36b379ad832963fec1529ea98d1bb5e1bf3acc0e210b6',
    'top-level':
      'sha256:113e331763502fcfadfa3f7de2e2abcebd966a1af4e3bd2ac25d65ace3e7cc08',
  },
};
const dockerRegistryClient: DockerRegistryClient = {
  async getDigestForTag({
    packageName,
    tagName,
  }: GetDigestForTagOptions): Promise<string> {
    return imageTagMap[packageName][tagName];
  },
  async getAllEquivalentTags() {
    return [];
  },
  async getGitCommitsBetweenTags() {
    return { type: 'no-commits' };
  },
};

describe('action', () => {
  it('updates graph artifact refs', async () => {
    const contents = await fixture('sample.yaml');
    const newContents = await updateGraphArtifactRefs(
      contents,
      dockerRegistryClient,
      new Set<string>(),
      logger,
    );
    expect(newContents).toMatchSnapshot();
  });
});
