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
    const digest = imageTagMap[packageName]?.[tagName];
    if (!digest) {
      throw new Error(`The tag '${tagName}' on the image '${packageName}'
        does not exist. Check that both the image and tag are spelled correctly.`);
    }
    return digest;
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

  describe('edge cases and error handling', () => {
    it('handles empty YAML file gracefully', async () => {
      const contents = await fixture('empty.yaml');
      const newContents = await updateGraphArtifactRefs(
        contents,
        dockerRegistryClient,
        new Set<string>(),
        logger,
      );
      expect(newContents).toBe(contents);
    });

    it('handles YAML with only whitespace gracefully', async () => {
      const contents = await fixture('whitespace-only.yaml');
      const newContents = await updateGraphArtifactRefs(
        contents,
        dockerRegistryClient,
        new Set<string>(),
        logger,
      );
      expect(newContents).toBe(contents);
    });

    it('handles YAML without any trackSupergraph entries', async () => {
      const contents = await fixture('no-track-supergraph.yaml');
      const newContents = await updateGraphArtifactRefs(
        contents,
        dockerRegistryClient,
        new Set<string>(),
        logger,
      );
      // Should return unchanged content since no trackSupergraph entries exist
      expect(newContents).toBe(contents);
    });

    it('handles malformed trackSupergraph value - missing colon', async () => {
      const contents = await fixture('malformed-track-supergraph-missing-colon.yaml');
      await expect(updateGraphArtifactRefs(
        contents,
        dockerRegistryClient,
        new Set<string>(),
        logger,
      )).rejects.toThrow('trackSupergraph `some-service-dev0` is invalid, must be in the format `image:tag`');
    });

    it('handles malformed trackSupergraph value - extra colons', async () => {
      const contents = await fixture('malformed-track-supergraph-extra-colons.yaml');
      await expect(updateGraphArtifactRefs(
        contents,
        dockerRegistryClient,
        new Set<string>(),
        logger,
      )).rejects.toThrow('trackSupergraph `some-service:dev0:extra` is invalid, must be in the format `image:tag`');
    });

    it('handles malformed trackSupergraph value - empty string', async () => {
      const contents = await fixture('malformed-track-supergraph-empty-string.yaml');
      await expect(updateGraphArtifactRefs(
        contents,
        dockerRegistryClient,
        new Set<string>(),
        logger,
      )).rejects.toThrow('trackSupergraph value is empty, must be in the format `image:tag`');
    });

    it('handles missing values section', async () => {
      const contents = await fixture('missing-values-section.yaml');
      await expect(updateGraphArtifactRefs(
        contents,
        dockerRegistryClient,
        new Set<string>(),
        logger,
      )).rejects.toThrow('`values` must be provided in the document if using trackSupergraph');
    });

    it('handles missing router section', async () => {
      const contents = await fixture('missing-router-section.yaml');
      await expect(updateGraphArtifactRefs(
        contents,
        dockerRegistryClient,
        new Set<string>(),
        logger,
      )).rejects.toThrow('`router` must be provided in the document if using trackSupergraph');
    });

    it('handles missing extraEnvVars section', async () => {
      const contents = await fixture('missing-extra-env-vars-section.yaml');
      await expect(updateGraphArtifactRefs(
        contents,
        dockerRegistryClient,
        new Set<string>(),
        logger,
      )).rejects.toThrow('`extraEnvVars` must be provided in the document if using trackSupergraph');
    });

    it('handles missing GRAPH_ARTIFACT_REFERENCE environment variable', async () => {
      const contents = await fixture('missing-graph-artifact-reference.yaml');
      await expect(updateGraphArtifactRefs(
        contents,
        dockerRegistryClient,
        new Set<string>(),
        logger,
      )).rejects.toThrow('Document does not provide `some-service-dev0.values.router.extraEnvVars` with GRAPH_ARTIFACT_REFERENCE that is a map');
    });

    it('handles extraEnvVars that is not a sequence', async () => {
      const contents = await fixture('extra-env-vars-not-sequence.yaml');
      await expect(updateGraphArtifactRefs(
        contents,
        dockerRegistryClient,
        new Set<string>(),
        logger,
      )).rejects.toThrow('`extraEnvVars` must be provided in the document if using trackSupergraph');
    });

    it('handles GRAPH_ARTIFACT_REFERENCE that is not a map', async () => {
      const contents = await fixture('graph-artifact-reference-not-map.yaml');
      const newContents = await updateGraphArtifactRefs(
        contents,
        dockerRegistryClient,
        new Set<string>(),
        logger,
      );
      // Should update the valid GRAPH_ARTIFACT_REFERENCE entry while leaving the malformed one unchanged
      expect(newContents).toContain('artifacts-staging.api.apollographql.com/some-service@sha256:90ee9ef20ce29314b29ccbbf4c50c1a881e35fdba7f53445cc083247bba9a6fb');
      expect(newContents).toContain('- GRAPH_ARTIFACT_REFERENCE: \'not-a-map\'');
    });

    it('handles trackSupergraph with special characters in image name', async () => {
      const contents = await fixture('special-chars-image-name.yaml');
      await expect(updateGraphArtifactRefs(
        contents,
        dockerRegistryClient,
        new Set<string>(),
        logger,
      )).rejects.toThrow(/The tag 'dev0' on the image 'some-service-with-dashes'[\s\S]*does not exist[\s\S]*Check that both the image and tag are spelled correctly/);
    });

    it('handles trackSupergraph with special characters in tag', async () => {
      const contents = await fixture('special-chars-tag.yaml');
      await expect(updateGraphArtifactRefs(
        contents,
        dockerRegistryClient,
        new Set<string>(),
        logger,
      )).rejects.toThrow(/The tag 'dev-0' on the image 'some-service'[\s\S]*does not exist[\s\S]*Check that both the image and tag are spelled correctly/);
    });

    it('handles frozen environments correctly', async () => {
      const contents = await fixture('frozen-environment.yaml');
      const newContents = await updateGraphArtifactRefs(
        contents,
        dockerRegistryClient,
        new Set<string>(['some-service-dev0']), // This environment is frozen
        logger,
      );
      // Should return unchanged content since environment is frozen
      expect(newContents).toBe(contents);
    });

    it('handles mixed valid and invalid entries', async () => {
      const contents = await fixture('mixed-valid-invalid-entries.yaml');
      await expect(updateGraphArtifactRefs(
        contents,
        dockerRegistryClient,
        new Set<string>(),
        logger,
      )).rejects.toThrow('trackSupergraph `invalid:format:here` is invalid, must be in the format `image:tag`');
    });

    it('handles malformed YAML structure gracefully', async () => {
      const contents = await fixture('malformed-yaml-structure.yaml');
      const newContents = await updateGraphArtifactRefs(
        contents,
        dockerRegistryClient,
        new Set<string>(),
        logger,
      );
      // Should handle malformed YAML gracefully
      expect(newContents).toBeDefined();
    });
  });
});
