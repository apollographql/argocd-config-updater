import * as core from '@actions/core';
import { ArtifactRegistryClient } from '@google-cloud/artifact-registry';

export interface GetAllEquivalentTagsOptions {
  /** The name of the specific Docker image in question (ie, a Docker
   * "repository", not an Artifact Registry "repository" that contains them.) */
  dockerImageRepository: string;
  tag: string;
}

export interface DockerRegistryClient {
  getAllEquivalentTags(options: GetAllEquivalentTagsOptions): Promise<string[]>;
}

export class ArtifactRegistryDockerRegistryClient {
  private client: ArtifactRegistryClient;
  constructor(
    /** A string of the form
     * `projects/PROJECT/locations/LOCATION/repositories/REPOSITORY`; this is an
     * Artifact Registry repository, which is a set of Docker repositories. */
    private artifactRegistryRepository: string,
  ) {
    this.client = new ArtifactRegistryClient();
  }

  async getAllEquivalentTags({
    dockerImageRepository,
    tag,
  }: GetAllEquivalentTagsOptions): Promise<string[]> {
    // Input is relatively trusted; this is largely to prevent mistaken uses
    // like specifying a full Docker-style repository with slashes.
    if (dockerImageRepository.includes('/')) {
      throw Error('repository cannot contain a slash');
    }
    if (tag.includes('/')) {
      throw Error('tag cannot contain a slash');
    }

    const tagPrefix = `${this.artifactRegistryRepository}/packages/${dockerImageRepository}/tags/`;

    core.info(`Fetching tag ${tagPrefix}${tag}`);
    // Note: this throws if the repository or tag are not found.
    const { version } = (
      await this.client.getTag({ name: `${tagPrefix}${tag}` })
    )[0];
    if (!version) {
      throw Error(`No version found for ${dockerImageRepository}@${tag}`);
    }

    core.info(`Fetching version ${version}`);
    const { relatedTags } = (
      await this.client.getVersion({ name: version, view: 'FULL' })
    )[0];
    if (!relatedTags) {
      throw Error(`No related tags returned for ${version}`);
    }
    return relatedTags.map(({ name }) => {
      if (!name?.startsWith(tagPrefix)) {
        throw Error(
          `Expected tag name to start with '${tagPrefix}'; got '${name}'`,
        );
      }
      return name.slice(tagPrefix.length);
    });
  }
}
